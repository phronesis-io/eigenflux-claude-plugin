/**
 * Stream client for EigenFlux private message updates.
 * Manages a long-running `eigenflux stream` child process that outputs NDJSON.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface as ReadlineInterface } from 'readline';

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
  private childExit: Promise<void> = Promise.resolve();
  private delivery: Promise<void> = Promise.resolve();
  private cursorBlocked = false;
  private cliVersion: string | null = null;
  private handoff: Promise<void> | null = null;
  private stoppingPromise: Promise<void> | null = null;
  private rolling = false;
  private readline: ReadlineInterface | null = null;
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
    if (this.running || this.stoppingPromise || this.rolling || (this.child && !this.childExited)) {
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
      this.readline?.close();
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
    if (version === this.cliVersion) return;
    if (!this.running || this.stopping) {
      this.cliVersion = version;
      return;
    }
    this.rolling = true;
    this.clearRestart();
    this.readline?.pause();
    this.handoff = (async () => {
      await this.waitForDelivery();
      if (this.stopping) return;
      this.readline?.close();
      await this.terminateChild();
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
      // A timed-out notification keeps its original process and resumes input.
      if (!this.stopping) this.readline?.resume();
    }
  }

  private clearRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private async waitForDelivery(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.delivery,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('PM notification drain timed out')),
            this.config.notificationGraceMs ?? 30_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = this.childExit;
    const wait = async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), this.stopGraceMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    if (!this.childExited) {
      child.kill('SIGTERM');
      if (!await wait()) {
        child.kill('SIGKILL');
        if (!await wait()) throw new Error('Previous PM process has not exited');
      }
    }
    if (this.child === child) this.child = null;
  }

  private spawnStreamProcess(): void {
    if (this.stopping || !this.running) {
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
    this.cursorBlocked = false;
    this.childExit = new Promise<void>((resolve) => {
      const markExited = () => {
        if (this.child === child) this.childExited = true;
        resolve();
      };
      child.once('exit', markExited);
      // Spawn failures may emit close without exit.
      child.once('close', markExited);
    });

    const rl = createInterface({ input: child.stdout! });
    this.readline = rl;

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
      this.scheduleRestart();
    });

    child.on('exit', (code, signal) => {
      log(`[eigenflux:stream] Process exited (code=${code}, signal=${signal})`);

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

      // Commit the resume cursor only after notification delivery. A failed
      // delivery pins the cursor so a replacement can replay the failed page.
      this.delivery = this.delivery.then(async () => {
        await this.config.onPmEvent(event);
        if (!this.cursorBlocked && event.data?.next_cursor) {
          this.lastCursor = event.data.next_cursor;
        }
      }).catch((err) => {
        this.cursorBlocked = true;
        log(`[eigenflux:stream] PM event handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      log(`[eigenflux:stream] Failed to parse line: ${(err as Error).message}`);
    }
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
        if (this.child === previousChild && this.childExited && !this.rolling) {
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
