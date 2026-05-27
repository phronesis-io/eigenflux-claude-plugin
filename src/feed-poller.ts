/**
 * Feed poller for EigenFlux broadcast items.
 * Uses the eigenflux CLI (`eigenflux feed poll`) instead of direct HTTP calls.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import type { FeedResponse } from './types.js';
import { execEigenflux } from './cli-executor.js';

const log = console.error;

export interface FeedPollerConfig {
  serverName: string;
  eigenfluxBin: string;
  pollIntervalSec: number;
  onFeedUpdate: (payload: FeedResponse) => Promise<void>;
  onAuthRequired: (reason: string) => Promise<void>;
}

// Guard: notifier delivery may take longer than the poll interval,
// so we skip overlapping deliveries to avoid duplicate notifications.
const DELIVERY_TIMEOUT_MS = 300_000;

export class FeedPoller {
  private config: FeedPollerConfig;
  private timeoutId: NodeJS.Timeout | null = null;
  private running = false;
  private authPrompted = false;
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
    log(`[eigenflux:feed] Starting poller for server=${this.config.serverName} (interval: ${this.config.pollIntervalSec}s)`);

    // Immediate poll, then chain-schedule subsequent polls
    this.pollOnce()
      .catch((err) => {
        log('[eigenflux:feed] Initial poll error:', err);
      })
      .finally(() => {
        this.scheduleNext();
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

  private scheduleNext(): void {
    if (!this.running) return;

    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      this.pollOnce()
        .catch((err) => {
          log('[eigenflux:feed] Poll error:', err);
        })
        .finally(() => {
          this.scheduleNext();
        });
    }, this.config.pollIntervalSec * 1000);
  }

  async pollOnce(): Promise<FeedResponse | null> {
    try {
      log(`[eigenflux:feed] Polling via CLI for server=${this.config.serverName}`);

      const result = await execEigenflux<FeedResponse['data']>(
        this.config.eigenfluxBin,
        ['feed', 'poll', '--limit', '20', '--action', 'refresh', '-s', this.config.serverName, '-f', 'json']
      );

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

      // Reset auth flag on success
      this.authPrompted = false;

      const items = data.data.items ?? [];
      const notifications = data.data.notifications ?? [];
      log(
        `[eigenflux:feed] Polled: ${items.length} items, ${notifications.length} notifications, has_more=${data.data.has_more}`
      );

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
