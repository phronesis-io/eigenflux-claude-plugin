/**
 * Retry cadence driving `eigenflux feed event flush` (behavior-event upload).
 *
 * The CLI owns the queue, batching, and dedup; it flushes one batch and
 * reports `{ flushed, remaining, ok }` without any back-off of its own.
 * Deciding *when* to retry lives here: a flush that fails with events still
 * pending arms an exponential back-off (5s base, 5min cap); a clean flush
 * (or empty queue) resets it and the loop goes idle until the next kick.
 *
 * The agent records events itself via `eigenflux feed event push` (see the
 * ef-broadcast skill's contract step 11); this loop only guarantees queued
 * events eventually reach the backend. Kicked on every successful feed poll.
 *
 * Ported from the OpenClaw plugin's feedback-flush-loop (same constants).
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import { execEigenflux, type CliResult, type ExecOptions } from './cli-executor.js';

const log = console.error;

export const DEFAULT_BASE_BACKOFF_MS = 5_000;
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

export type ExecFn = <T>(bin: string, args: string[], options?: ExecOptions) => Promise<CliResult<T>>;

interface FlushResult {
  flushed?: number;
  remaining?: number;
  ok?: boolean;
}

export interface FlushLoopConfig {
  serverName: string;
  eigenfluxBin: string;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  exec?: ExecFn;
}

export class FeedbackFlushLoop {
  private readonly serverName: string;
  private readonly eigenfluxBin: string;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly exec: ExecFn;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private currentBackoff: number;

  constructor(config: FlushLoopConfig) {
    this.serverName = config.serverName;
    this.eigenfluxBin = config.eigenfluxBin;
    this.baseBackoffMs = config.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.exec = config.exec ?? execEigenflux;
    this.currentBackoff = this.baseBackoffMs;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log(`[eigenflux:flush] Starting feedback flush loop for server=${this.serverName}`);
    // Kick once on start to drain anything a previous run left on disk.
    void this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.currentBackoff = this.baseBackoffMs;
    log(`[eigenflux:flush] Stopped`);
  }

  /** Nudge an immediate flush (e.g. after each successful feed poll). */
  kick(): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.tick();
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      const result = await this.exec<FlushResult>(
        this.eigenfluxBin,
        ['feed', 'event', 'flush', '-s', this.serverName]
      );

      if (!this.running) return;

      const data = result.kind === 'success' ? (result.data ?? {}) : {};
      const remaining = typeof data.remaining === 'number' ? data.remaining : 0;
      const ok = data.ok !== false;

      // Retry only when the push failed AND events are still pending. A clean
      // flush (or an empty queue) resets the back-off and idles the loop.
      if (result.kind === 'success' && remaining > 0 && !ok) {
        log(`[eigenflux:flush] ${remaining} events pending; retrying in ${this.currentBackoff}ms`);
        const delay = this.currentBackoff;
        this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoffMs);
        this.schedule(delay);
      } else {
        this.currentBackoff = this.baseBackoffMs;
      }
    } catch (err) {
      log(`[eigenflux:flush] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.inFlight = false;
    }
  }
}
