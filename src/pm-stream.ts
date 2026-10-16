/**
 * Stream client for EigenFlux private message updates.
 * Manages a long-running `eigenflux stream` child process that outputs NDJSON.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';

const log = console.error;

// Exported so tests exercise the real implementation against the real
// constants instead of re-declaring them.
export const EXIT_AUTH_REQUIRED = 4;
export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;
export const BACKOFF_MULTIPLIER = 2;
export const STOP_GRACE_MS = 5_000;
export const MAX_CONSECUTIVE_FAILURES = 20;

/** Minimal spawn seam so tests can drive the client with a fake process. */
export type SpawnFn = (
  bin: string,
  args: string[],
  options: { stdio: ['ignore', 'pipe', 'pipe']; env: NodeJS.ProcessEnv }
) => ChildProcess;

export interface PmStreamEvent {
  type: string;
  data: {
    messages?: Array<{
      msg_id: string;
      conv_id: string;
      sender_id?: string;
      sender_name?: string;
      content: string;
      created_at: number;
    }>;
    next_cursor?: string;
    [key: string]: unknown;
  };
}

export interface PmStreamClientConfig {
  serverName: string;
  eigenfluxHome?: string;
  eigenfluxBin: string;
  onPmEvent: (event: PmStreamEvent) => Promise<void>;
  onAuthRequired: () => Promise<void>;
  /** Test seams; production uses child_process.spawn and the exported defaults. */
  spawnFn?: SpawnFn;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  maxConsecutiveFailures?: number;
  stopGraceMs?: number;
  notificationGraceMs?: number;
}

export class PmStreamClient {
  private config: PmStreamClientConfig;
  private readonly spawnFn: SpawnFn;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly stopGraceMs: number;
  private child: ChildProcess | null = null;
  private childExited = true;
  private childClosed = true;
  private childClose: Promise<void> = Promise.resolve();
  private delivery: Promise<void> = Promise.resolve();
  private pendingEvents: PmStreamEvent[] = [];
  private delivering = false;
  private cliVersion: string | null = null;
  private handoff: Promise<void> | null = null;
  private stoppingPromise: Promise<void> | null = null;
  private rolling = false;
  private stopping = false;
  private running = false;
  private lastCursor: string | null = null;
  private backoffMs: number;
  private consecutiveFailures = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(config: PmStreamClientConfig) {
    this.config = config;
    this.spawnFn = config.spawnFn ?? (spawn as unknown as SpawnFn);
    this.initialBackoffMs = config.initialBackoffMs ?? INITIAL_BACKOFF_MS;
    this.maxBackoffMs = config.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
    this.stopGraceMs = config.stopGraceMs ?? STOP_GRACE_MS;
    this.backoffMs = this.initialBackoffMs;
  }

  isRunning(): boolean {
    return this.running;
  }

  getLastCursor(): string | null {
    return this.lastCursor;
  }

  start(): void {
    if (this.running || this.stoppingPromise || this.rolling || (this.child && !this.childClosed)) {
      log('[eigenflux:stream] Stream client already running');
      return;
    }

    this.running = true;
    this.stopping = false;
    log(`[eigenflux:stream] Starting stream client for server=${this.config.serverName}`);
    this.spawnStreamProcess();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.clearRestart();
    if (this.stoppingPromise) return this.stoppingPromise;
    this.stoppingPromise = (async () => {
      if (this.handoff) await this.handoff.catch(() => {});
      await this.terminateChild();
      await this.waitForDelivery();
    })();
    try {
      await this.stoppingPromise;
    } finally {
      this.stoppingPromise = null;
    }
  }

  /** Unknown stream versions are reconciled on the first modern plan too. */
  async refreshForCliVersion(version: string): Promise<void> {
    if (!/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) return;
    if (this.handoff) await this.handoff;
    if (version === this.cliVersion) {
      await this.waitForDelivery();
      return;
    }
    if (!this.running || this.stopping) {
      this.cliVersion = version;
      return;
    }
    this.rolling = true;
    this.clearRestart();
    log(`[eigenflux:stream] CLI handoff requested (from=${this.cliVersion ?? 'unknown'}, to=${version}, pending=${this.pendingEvents.length})`);
    this.handoff = (async () => {
      // Keep stdout attached through close: a process can exit while unread
      // messages are still buffered in its pipes.
      await this.terminateChild();
      await this.waitForDelivery();
      if (this.stopping || !this.running) return;
      log(`[eigenflux:stream] Loading CLI ${version}`);
      this.spawnStreamProcess();
      this.cliVersion = version;
    })();
    try {
      await this.handoff;
    } finally {
      this.handoff = null;
      this.rolling = false;
    }
  }

  private clearRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private async waitForDelivery(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      this.deliverPending();
      await Promise.race([
        this.delivery,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('PM notification drain timed out')),
            this.config.notificationGraceMs ?? 30_000);
        }),
      ]);
      if (this.pendingEvents.length) {
        throw new Error(`PM notifications remain pending (${this.pendingEvents.length})`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const closed = this.childClose;
    const wait = async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          closed.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), this.stopGraceMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    if (!this.childClosed) {
      if (!this.childExited) child.kill('SIGTERM');
      if (!await wait()) {
        if (!this.childExited) child.kill('SIGKILL');
        if (!await wait()) throw new Error('Previous PM process stdio has not closed');
      }
    }
    if (this.child === child) {
      this.child = null;
    }
  }

  private spawnStreamProcess(): void {
    if (this.stopping || !this.running) {
      return;
    }
    if (this.pendingEvents.length) {
      this.scheduleRestart();
      return;
    }

    const args = ['stream', '-s', this.config.serverName, '-f', 'json'];
    if (this.config.eigenfluxHome) args.push('--homedir', this.config.eigenfluxHome);
    if (this.lastCursor) {
      args.push('--cursor', this.lastCursor);
    }

    log(`[eigenflux:stream] Spawning: ${this.config.eigenfluxBin} ${args.join(' ')}`);

    const child = this.spawnFn(this.config.eigenfluxBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.child = child;
    this.childExited = false;
    this.childClosed = false;
    this.childClose = new Promise<void>((resolve) => {
      child.once('exit', () => {
        if (this.child === child) this.childExited = true;
      });
      child.once('close', () => {
        if (this.child === child) {
          this.childExited = true;
          this.childClosed = true;
        }
        resolve();
      });
    });

    const rl = createInterface({ input: child.stdout! });

    rl.on('line', (line) => {
      if (this.child === child) this.handleLine(line);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        log(`[eigenflux:stream] stderr: ${text}`);
      }
    });

    child.on('error', (err) => {
      if (this.child !== child) return;
      log(`[eigenflux:stream] Process error: ${err.message}`);
    });

    child.on('close', (code, signal) => {
      log(`[eigenflux:stream] Process stdio closed (code=${code}, signal=${signal})`);

      if (this.child !== child || this.stopping || this.rolling) {
        return;
      }

      if (code === EXIT_AUTH_REQUIRED) {
        log('[eigenflux:stream] Auth required');
        this.config.onAuthRequired().then(() => {
          this.scheduleRestart();
        }).catch((err) => {
          log(`[eigenflux:stream] Auth handler error: ${err instanceof Error ? err.message : String(err)}`);
          this.scheduleRestart();
        });
        return;
      }

      this.scheduleRestart();
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const event = JSON.parse(trimmed) as PmStreamEvent;

      // Reset backoff on successful message
      this.backoffMs = this.initialBackoffMs;
      this.consecutiveFailures = 0;

      this.pendingEvents.push(event);
      this.deliverPending();
    } catch (err) {
      log(`[eigenflux:stream] Failed to parse line: ${(err as Error).message}`);
    }
  }

  private deliverPending(): void {
    if (this.delivering || !this.pendingEvents.length) return;
    this.delivering = true;
    this.delivery = (async () => {
      while (this.pendingEvents.length) {
        const event = this.pendingEvents[0];
        await this.config.onPmEvent(event);
        if (event.data?.next_cursor) this.lastCursor = event.data.next_cursor;
        this.pendingEvents.shift();
      }
    })().catch((err) => {
      // Backend fetch may already mark messages read. Retain the actual event;
      // an older cursor cannot recover a failed channel notification.
      log(`[eigenflux:stream] PM notification retained for retry (pending=${this.pendingEvents.length}): ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
      this.delivering = false;
    });
  }

  private scheduleRestart(): void {
    if (this.stopping || !this.running || this.rolling || this.restartTimer) {
      return;
    }

    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      log(`[eigenflux:stream] Giving up after ${this.maxConsecutiveFailures} consecutive failures`);
      this.running = false;
      return;
    }

    log(`[eigenflux:stream] Reconnecting in ${this.backoffMs}ms (failure #${this.consecutiveFailures})`);

    const previousChild = this.child;
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      try {
        await this.waitForDelivery();
        if (this.child === previousChild && this.childClosed && !this.rolling) {
          this.spawnStreamProcess();
        }
      } catch (error) {
        log(`[eigenflux:stream] Reconnect deferred: ${String(error)}`);
        this.scheduleRestart();
      }
    }, this.backoffMs);

    this.backoffMs = Math.min(
      this.backoffMs * BACKOFF_MULTIPLIER,
      this.maxBackoffMs
    );
  }
}
