/**
 * Daily profile auto-refresh for EigenFlux.
 *
 * Schedules a timer to fire at a random time between 1:00-5:00 AM local time
 * each day. When triggered, gathers the host context (CLAUDE.md memory +
 * recent session snippets) and asks the host-agnostic CLI core
 * (`eigenflux profile refresh-prompt`) to assemble the refresh prompt, which
 * is delivered as a channel notification for Claude to process. After a
 * delivered bio refresh, chains the daily status broadcast
 * (`eigenflux profile status-prompt`), auto-publish gated by the user's
 * `recurring_publish` setting (fail-closed: only an explicit true publishes
 * without confirmation).
 *
 * Prompt wording and memory handling live in the CLI, once, for every host —
 * this file only schedules, collects context, and delivers.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 *
 * TODO: 未来将 feedPoller、pmStream、profileRefresher 统一为
 * 单个 `eigenflux heartbeat` 守护进程，减少插件端的管理开销。
 */

import { execEigenflux } from './cli-executor.js';
import { collectClaudeCodeContext, EMPTY_CONTEXT, type RefreshContext } from './claude-code-context.js';

const log = console.error;

const REFRESH_WINDOW_START = 1; // 1:00 AM
const REFRESH_WINDOW_END = 5;   // 5:00 AM (exclusive)

export interface ProfileRefresherConfig {
  serverName: string;
  eigenfluxBin: string;
  onRefreshPrompt: (prompt: string) => Promise<void>;
  /** Status-broadcast prompt; auto=true when recurring_publish is on. */
  onStatusPrompt?: (prompt: string, opts: { auto: boolean }) => Promise<void>;
  onAuthRequired: () => Promise<void>;
  /** Best-effort side task run on every daily tick (e.g. skills sync). */
  onTick?: () => Promise<void>;
  /** Injectable for tests; defaults to the Claude Code collector. */
  collectContext?: () => RefreshContext;
}

export class ProfileRefresher {
  private config: ProfileRefresherConfig;
  private timeoutId: NodeJS.Timeout | null = null;
  private running = false;

  constructor(config: ProfileRefresherConfig) {
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log(`[eigenflux:profile-refresh] Starting for server=${this.config.serverName}`);
    this.scheduleNext();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    log(`[eigenflux:profile-refresh] Stopped`);
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const delay = msUntilNextRefresh(new Date());
    const target = new Date(Date.now() + delay);
    log(`[eigenflux:profile-refresh] Next refresh at ${target.toLocaleTimeString()} (in ${Math.round(delay / 60_000)}min)`);
    this.timeoutId = setTimeout(async () => {
      this.timeoutId = null;
      try {
        await this.refresh();
      } catch (err) {
        log(`[eigenflux:profile-refresh] Refresh crashed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Piggy-back best-effort daily tasks (e.g. skills auto-sync) on the same
      // once/day cadence, independent of whether the refresh above ran.
      if (this.config.onTick) {
        try {
          await this.config.onTick();
        } catch (err) {
          log(`[eigenflux:profile-refresh] Daily tick hook crashed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.scheduleNext();
    }, delay);
  }

  private async refresh(): Promise<void> {
    log(`[eigenflux:profile-refresh] Running refresh`);

    // 1. Host context: memory dirs + recent session snippets.
    let context: RefreshContext = EMPTY_CONTEXT;
    try {
      context = (this.config.collectContext ?? collectClaudeCodeContext)() ?? EMPTY_CONTEXT;
    } catch (err) {
      log(`[eigenflux:profile-refresh] Context collection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { memoryDirs, sessionSnippets } = context;

    if (memoryDirs.length === 0 && sessionSnippets.length === 0) {
      log('[eigenflux:profile-refresh] Skipped: no memory/session context');
      this.telemetry('profile_refresh_telemetry', { outcome: 'skipped_no_context', delivered: false });
      return;
    }

    if (!this.running) return;

    // 2. CLI core assembles the prompt; empty stdout = nothing to refresh from.
    const result = await execEigenflux<string>(
      this.config.eigenfluxBin,
      [
        'profile', 'refresh-prompt', '-s', this.config.serverName,
        ...memoryDirs.flatMap((d) => ['--memory-dir', d]),
        ...sessionSnippets.flatMap((s) => ['--session-snippet', s]),
      ],
      { parseJson: false }
    );

    if (!this.running) return;

    if (result.kind === 'auth_required') {
      this.telemetry('profile_refresh_telemetry', { outcome: 'auth_required', delivered: false });
      await this.config.onAuthRequired();
      return;
    }
    if (result.kind !== 'success') {
      log(`[eigenflux:profile-refresh] refresh-prompt failed: ${result.kind}`);
      this.telemetry('profile_refresh_telemetry', { outcome: result.kind, delivered: false });
      return;
    }

    const prompt = (result.data ?? '').trim();
    if (!prompt) {
      log('[eigenflux:profile-refresh] Skipped: CLI produced no prompt');
      this.telemetry('profile_refresh_telemetry', { outcome: 'skipped_no_context', delivered: false });
      return;
    }

    // 3. Deliver.
    let bioDelivered = false;
    try {
      if (!this.running) return;
      await this.config.onRefreshPrompt(prompt);
      bioDelivered = true;
      log(`[eigenflux:profile-refresh] Prompt delivered`);
      this.telemetry('profile_refresh_telemetry', { outcome: 'delivered', delivered: true });
    } catch (err) {
      log(`[eigenflux:profile-refresh] Delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      this.telemetry('profile_refresh_telemetry', { outcome: 'delivery_failed', delivered: false });
    }

    // 4. Chain the daily status broadcast — only after the bio was delivered,
    // so the broadcast reflects the freshly-updated identity. Best-effort.
    if (bioDelivered) {
      await this.maybeBroadcastStatus(memoryDirs, sessionSnippets);
    }
  }

  private async maybeBroadcastStatus(memoryDirs: string[], sessionSnippets: string[]): Promise<void> {
    if (!this.config.onStatusPrompt) return;
    try {
      if (!this.running) return;

      // Fail-closed: default to draft-and-confirm. Auto-publish sends the
      // user's status to the public network without review, so an unreadable
      // setting must never enable it — only an explicit true does.
      let auto = false;
      try {
        const r = await execEigenflux<string>(
          this.config.eigenfluxBin,
          ['config', 'get', '--key', 'recurring_publish', '-s', this.config.serverName],
          { parseJson: false }
        );
        auto = r.kind === 'success' && (r.data ?? '').trim().toLowerCase() === 'true';
      } catch {
        // keep auto=false
      }

      // Pass the bool as `--auto-publish=<bool>` (single arg): cobra bool
      // flags don't consume the next token, so the space form would silently
      // coerce to true and flip an OFF user into auto-publish.
      const result = await execEigenflux<string>(
        this.config.eigenfluxBin,
        [
          'profile', 'status-prompt', '-s', this.config.serverName,
          `--auto-publish=${auto}`,
          ...memoryDirs.flatMap((d) => ['--memory-dir', d]),
          ...sessionSnippets.flatMap((s) => ['--session-snippet', s]),
        ],
        { parseJson: false }
      );

      if (!this.running) return;

      if (result.kind === 'auth_required') {
        this.telemetry('status_broadcast_telemetry', { outcome: 'auth_required', auto, delivered: false });
        await this.config.onAuthRequired();
        return;
      }
      if (result.kind !== 'success') {
        log(`[eigenflux:profile-refresh] status-prompt failed: ${result.kind}`);
        this.telemetry('status_broadcast_telemetry', { outcome: result.kind, auto, delivered: false });
        return;
      }

      const prompt = (result.data ?? '').trim();
      if (!prompt) {
        this.telemetry('status_broadcast_telemetry', { outcome: 'skipped_no_context', auto, delivered: false });
        return;
      }

      if (!this.running) return;
      try {
        await this.config.onStatusPrompt(prompt, { auto });
        log(`[eigenflux:profile-refresh] Status broadcast prompt delivered (auto=${auto})`);
        this.telemetry('status_broadcast_telemetry', { outcome: 'delivered', auto, delivered: true });
      } catch (err) {
        log(`[eigenflux:profile-refresh] Status delivery failed: ${err instanceof Error ? err.message : String(err)}`);
        this.telemetry('status_broadcast_telemetry', { outcome: 'delivery_failed', auto, delivered: false });
      }
    } catch (err) {
      log(`[eigenflux:profile-refresh] Status broadcast step crashed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One grep-able structured line per attempt. Never throws. */
  private telemetry(tag: string, fields: Record<string, unknown>): void {
    try {
      log(`[eigenflux:profile-refresh] ${tag} ${JSON.stringify({ server: this.config.serverName, ...fields })}`);
    } catch {
      // telemetry must never break the loop
    }
  }
}

export function msUntilNextRefresh(now: Date): number {
  const target = new Date(now);
  const hour = REFRESH_WINDOW_START + Math.floor(Math.random() * (REFRESH_WINDOW_END - REFRESH_WINDOW_START));
  target.setHours(hour, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}
