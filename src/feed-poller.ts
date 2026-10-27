/**
 * Feed poller for EigenFlux broadcast items.
 * Uses the eigenflux CLI (`eigenflux feed poll`) instead of direct HTTP calls.
 *
 * The poll interval is read fresh from the CLI config (`feed_poll_interval`)
 * before each scheduling, so dashboard/CLI changes take effect within one
 * cycle; the EIGENFLUX_FEED_POLL_INTERVAL env var overrides when set.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import type { FeedResponse } from './types.js';
import { execEigenflux, type CliResult, type ExecOptions } from './cli-executor.js';
import { readPollIntervalSec } from './poll-interval.js';
import { DEFAULT_POLL_INTERVAL_SEC } from './config.js';
import { getInstalledCliVersion, supportsHeartbeatOrigin } from './cli-version.js';
import type { HeartbeatPlan, HeartbeatStartResult } from './heartbeat-plan-runner.js';

const log = console.error;
export type ExecFn = <T>(bin: string, args: string[], options?: ExecOptions) => Promise<CliResult<T>>;

export interface FeedPollerConfig {
  serverName: string;
  eigenfluxBin: string;
  /** Env override; null = read the CLI config dynamically each cycle. */
  pollIntervalOverrideSec: number | null;
  onFeedUpdate: (payload: FeedResponse, heartbeatPlan: HeartbeatPlan | null) => Promise<void>;
  onAuthRequired: (reason: string) => Promise<void>;
  /**
   * Fired on EVERY poll that finds the CLI binary missing (ENOENT). The
   * channel layer owns dedup/episode semantics (latches only after a
   * successfully delivered notification, reset on poll success), so the
   * poller deliberately keeps no gate of its own — a failed send retries
   * on the next poll instead of going permanently silent.
   */
  onCliMissing?: () => Promise<void>;
  /** Returns this cycle's central Agent instructions before the single Feed poll. */
  onHeartbeatStart?: () => Promise<HeartbeatStartResult>;
  /** Fired after every successful poll, including empty feeds. Best-effort. */
  onPollSuccess?: () => Promise<void> | void;
  /** Maintenance continues when polling is held for plan or capacity. */
  onPollSkipped?: () => Promise<void> | void;
  /** Test seam; production uses the shared CLI executor. */
  exec?: ExecFn;
}

export class FeedPoller {
  private config: FeedPollerConfig;
  private timeoutId: NodeJS.Timeout | null = null;
  private running = false;
  private deliveryInFlight = false;
  private polling = false;
  private cliVersion: Promise<string | null> | null = null;
  private pending: {data: FeedResponse; plan: HeartbeatPlan; attempts: number} | null = null;
  private activeDelivery: Promise<void> | null = null;

  constructor(config: FeedPollerConfig) {
    this.config = config;
  }

  start(): void {
    if (this.running) {
      log('[eigenflux:feed] Poller already running');
      return;
    }

    this.running = true;
    const intervalNote = this.config.pollIntervalOverrideSec !== null
      ? `${this.config.pollIntervalOverrideSec}s (env override)`
      : `dynamic (CLI config, default ${DEFAULT_POLL_INTERVAL_SEC}s)`;
    log(`[eigenflux:feed] Starting poller for server=${this.config.serverName} (interval: ${intervalNote})`);

    // Immediate poll, then chain-schedule subsequent polls
    this.pollOnce()
      .catch((err) => {
        log('[eigenflux:feed] Initial poll error:', err);
      })
      .finally(() => {
        void this.scheduleNext();
      });
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    log('[eigenflux:feed] Stopping poller');
    this.running = false;

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    // Wait for in-flight delivery to complete
    if (this.activeDelivery) {
      log('[eigenflux:feed] Waiting for in-flight delivery to complete before stop');
      try {
        await this.activeDelivery;
      } catch {
        // Swallow — we're stopping anyway
      }
    }
  }

  private async scheduleNext(): Promise<void> {
    if (!this.running) return;

    const intervalSec = this.config.pollIntervalOverrideSec
      ?? await readPollIntervalSec(this.config.eigenfluxBin, this.config.serverName);

    if (!this.running) return;

    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      this.pollOnce()
        .catch((err) => {
          log('[eigenflux:feed] Poll error:', err);
        })
        .finally(() => {
          void this.scheduleNext();
        });
    }, intervalSec * 1000);
  }

  private async skipped(): Promise<null> {
    try { await this.config.onPollSkipped?.(); } catch (error) { log('[eigenflux:feed] maintenance failed:', error); }
    return null;
  }

  private async deliverPending(): Promise<void> {
    const pending = this.pending;
    if (!pending || this.deliveryInFlight) return;
    this.deliveryInFlight = true;
    pending.attempts++;
    const delivery = Promise.resolve().then(() => this.config.onFeedUpdate(pending.data, pending.plan));
    this.activeDelivery = delivery;
    try {
      await delivery;
      this.pending = null;
    } catch (error) {
      log(`[eigenflux:feed] Delivery attempt ${pending.attempts}/2 failed: ${String(error)}`);
      if (pending.attempts >= 2) {
        log('[eigenflux:feed] Dropping payload after two failed deliveries');
        this.pending = null;
      }
    } finally {
      this.deliveryInFlight = false;
      this.activeDelivery = null;
    }
  }

  async pollOnce(): Promise<FeedResponse | null> {
    if (this.polling || this.deliveryInFlight) return this.skipped();
    this.polling = true;
    try {
      if (this.pending) {
        const data = this.pending.data;
        await this.deliverPending();
        await this.skipped();
        return data;
      }
      let started: HeartbeatStartResult = null;
      try { started = await this.config.onHeartbeatStart?.() ?? null; }
      catch (error) { log('[eigenflux:feed] heartbeat plan unavailable:', error); }
      if (started && 'kind' in started && started.kind === 'auth_required') {
        await this.config.onAuthRequired(started.stderr);
        return null;
      }
      if (started && 'kind' in started && started.kind === 'auth_unavailable') {
        log(`[eigenflux:feed] Credential acquisition unavailable; cycle stopped: ${started.stderr}`);
        return null;
      }
      if (started && 'kind' in started && started.kind === 'not_installed') {
        await this.config.onCliMissing?.();
        return this.skipped();
      }
      const plan = started && 'agent_prompt' in started ? started : null;
      if (!plan) {
        log('[eigenflux:feed] Skipping poll: current heartbeat plan unavailable');
        return this.skipped();
      }
      this.cliVersion ??= getInstalledCliVersion(this.config.eigenfluxBin, this.config.exec ?? execEigenflux);
      const origin = supportsHeartbeatOrigin(await this.cliVersion) ? ['--origin', 'heartbeat'] : [];
      const result = await (this.config.exec ?? execEigenflux)<FeedResponse['data']>(
        this.config.eigenfluxBin,
        ['feed', 'poll', '--limit', '20', '--action', 'refresh', '-s', this.config.serverName, '-f', 'json', ...origin]
      );
      if (result.kind === 'not_installed') {
        await this.config.onCliMissing?.();
        return null;
      }
      if (result.kind === 'auth_required') {
        await this.config.onAuthRequired(result.stderr);
        return null;
      }
      if (result.kind === 'error') {
        log(`[eigenflux:feed] CLI error: ${result.error.message}`);
        return null;
      }
      const data: FeedResponse = {code: 0, msg: 'success', data: result.data};
      try { await this.config.onPollSuccess?.(); }
      catch (error) { log('[eigenflux:feed] onPollSuccess hook error:', error); }
      if (plan.wake_on_empty || (data.data.items?.length ?? 0) > 0 || (data.data.notifications?.length ?? 0) > 0) {
        this.pending = {data, plan, attempts: 0};
        await this.deliverPending();
      }
      return data;
    } catch (error) {
      log('[eigenflux:feed] Poll failed:', error instanceof Error ? error.message : error);
      return null;
    } finally {
      this.polling = false;
    }
  }
}
