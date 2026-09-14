/**
 * Supplies Claude Code context to the central profile task on host heartbeats.
 * The CLI owns eligibility, due times, cooldowns, and task instructions.
 */

import { execEigenflux, type CliResult, type ExecOptions } from './cli-executor.js';
import { collectClaudeCodeContext, EMPTY_CONTEXT, type RefreshContext } from './claude-code-context.js';

const log = console.error;
type ExecFn = <T>(bin: string, args: string[], options?: ExecOptions) => Promise<CliResult<T>>;

export interface ProfileRefresherConfig {
  serverName: string;
  eigenfluxBin: string;
  onRefreshPrompt: (prompt: string) => Promise<void>;
  onAuthRequired: (detail: string) => Promise<void>;
  collectContext?: () => RefreshContext;
  exec?: ExecFn;
}

export class ProfileRefresher {
  private running = false;
  private inFlight = false;

  constructor(private readonly config: ProfileRefresherConfig) {}

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  async refresh(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      let context: RefreshContext = EMPTY_CONTEXT;
      try {
        context = (this.config.collectContext ?? collectClaudeCodeContext)() ?? EMPTY_CONTEXT;
      } catch (error) {
        log(`[eigenflux:profile-refresh] Context collection failed: ${String(error)}`);
      }
      if (!this.running) return;

      const result = await (this.config.exec ?? execEigenflux)<string>(
        this.config.eigenfluxBin,
        [
          'profile', 'refresh-task', '-s', this.config.serverName, '--format', 'agent',
          ...context.memoryDirs.flatMap((directory) => ['--memory-dir', directory]),
          ...context.sessionSnippets.flatMap((snippet) => ['--session-snippet', snippet]),
        ],
        { parseJson: false }
      );
      if (!this.running) return;
      if (result.kind === 'auth_required') {
        await this.config.onAuthRequired(result.stderr);
        return;
      }
      if (result.kind !== 'success') {
        const detail = result.kind === 'error' ? result.error.message : result.bin;
        log(`[eigenflux:profile-refresh] refresh-task failed: ${result.kind}: ${detail}`);
        return;
      }
      const prompt = result.data?.trim();
      if (prompt) await this.config.onRefreshPrompt(prompt);
    } catch (error) {
      log(`[eigenflux:profile-refresh] Task failed: ${String(error)}`);
    } finally {
      this.inFlight = false;
    }
  }
}
