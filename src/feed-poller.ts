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
import { execEigenflux } from './cli-executor.js';
import { readPollIntervalSec } from './poll-interval.js';
import { DEFAULT_POLL_INTERVAL_SEC } from './config.js';

const log = console.error;

export interface FeedPollerConfig {
  serverName: string;
  eigenfluxBin: string;
  /** Env override; null = read the CLI config dynamically each cycle. */
  pollIntervalOverrideSec: number | null;
  onFeedUpdate: (payload: FeedResponse) => Promise<void>;
  onAuthRequired: (reason: string) => Promise<void>;
  /** Fired once when the CLI binary is missing (ENOENT). */
  onCliMissing?: () => Promise<void>;
  /** Fired after every successful poll, including empty feeds. Best-effort. */
  onPollSuccess?: () => void;
}

// Guard: notifier delivery may take longer than the poll interval,
// so we skip overlapping deliveries to avoid duplicate notifications.
const DELIVERY_TIMEOUT_MS = 300_000;

export class FeedPoller {
  private config: FeedPollerConfig;
  private timeoutId: NodeJS.Timeout | null = null;
  private running = false;
  private authPrompted = false;
  private cliMissingPrompted = false;
  private deliveryInFlight = false;
  private deliveryStartedAt = 0;
  private deliverySkipCount = 0;
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

  async pollOnce(): Promise<FeedResponse | null> {
    try {
      log(`[eigenflux:feed] Polling via CLI for server=${this.config.serverName}`);

      const result = await execEigenflux<FeedResponse['data']>(
        this.config.eigenfluxBin,
        ['feed', 'poll', '--limit', '20', '--action', 'refresh', '-s', this.config.serverName, '-f', 'json']
      );

      if (result.kind === 'not_installed') {
        log(`[eigenflux:feed] CLI not installed (bin=${result.bin})`);
        if (!this.cliMissingPrompted && this.config.onCliMissing) {
          this.cliMissingPrompted = true;
          await this.config.onCliMissing();
        }
        return null;
      }

      if (result.kind === 'auth_required') {
        log('[eigenflux:feed] Auth required');
        if (!this.authPrompted) {
          this.authPrompted = true;
          await this.config.onAuthRequired('auth_required');
        }
        return null;
      }

      if (result.kind === 'error') {
        log(`[eigenflux:feed] CLI error: ${result.error.message}`);
        return null;
      }

      // Reconstruct full FeedResponse envelope from CLI data output
      const data: FeedResponse = {
        code: 0,
        msg: 'success',
        data: result.data,
      };

      // Reset prompts on success (CLI is back / auth restored)
      this.authPrompted = false;
      this.cliMissingPrompted = false;

      const items = data.data.items ?? [];
      const notifications = data.data.notifications ?? [];
      log(
        `[eigenflux:feed] Polled: ${items.length} items, ${notifications.length} notifications, has_more=${data.data.has_more}`
      );

      // Piggy-back per-poll best-effort tasks (settings push, feedback flush).
      if (this.config.onPollSuccess) {
        try {
          this.config.onPollSuccess();
        } catch (err) {
          log(`[eigenflux:feed] onPollSuccess hook error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (items.length > 0 || notifications.length > 0) {
        // Check for stale delivery flag (delivery promise hung)
        if (this.deliveryInFlight && this.deliveryStartedAt > 0) {
          const elapsed = Date.now() - this.deliveryStartedAt;
          if (elapsed > DELIVERY_TIMEOUT_MS) {
            log(`[eigenflux:feed] Delivery flag stuck for ${Math.round(elapsed / 1000)}s, force-resetting`);
            this.deliveryInFlight = false;
            this.activeDelivery = null;
          }
        }

        if (this.deliveryInFlight) {
          this.deliverySkipCount += 1;
          const elapsed = Date.now() - this.deliveryStartedAt;
          log(
            `[eigenflux:feed] Skipping feed delivery: previous delivery still in progress ` +
            `(elapsed=${Math.round(elapsed / 1000)}s, skipped_items=${items.length}, ` +
            `skipped_notifications=${notifications.length}, total_skips=${this.deliverySkipCount})`
          );
        } else {
          this.deliveryInFlight = true;
          const startedAt = Date.now();
          this.deliveryStartedAt = startedAt;
          const delivery = this.config.onFeedUpdate(data).finally(() => {
            const duration = Date.now() - startedAt;
            log(`[eigenflux:feed] Delivery completed in ${Math.round(duration / 1000)}s`);
            this.deliveryInFlight = false;
            this.activeDelivery = null;
          });
          this.activeDelivery = delivery;
          await delivery;
        }
      }

      return data;
    } catch (error) {
      log('[eigenflux:feed] Poll failed:', error instanceof Error ? error.message : error);
      return null;
    }
  }
}
