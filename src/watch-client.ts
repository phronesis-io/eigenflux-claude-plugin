import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { cliChildEnv } from './cli-executor.js';
import { normalizeHome } from './instance-leader.js';
import type { PmStreamEvent, SpawnFn } from './pm-stream.js';

export interface WatchEvent extends PmStreamEvent {
  schema_version: 'eigenflux_watch.v1';
  state_scope: string;
  event_id: string;
}

export interface WatchClientConfig {
  eigenfluxBin: string;
  eigenfluxHome: string;
  serverName: string;
  onEvent: (event: WatchEvent) => Promise<void>;
  onDiagnostic: (detail: string) => Promise<void>;
  onFatal?: (detail: string) => Promise<void>;
  spawnFn?: SpawnFn;
  retryMs?: number;
  stopGraceMs?: number;
  maxFailures?: number;
}

const TYPES = new Set(['started', 'runtime_ready', 'pm_push', 'friend_accepted', 'friend_rejected', 'profile_review_due', 'control_pending', 'maintenance_due', 'restart_required', 'diagnostic']);

/** Owns one CLI watch. A replacement never starts before the old process exits. */
export class WatchClient {
  private child: ChildProcess | null = null;
  private reader: Interface | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private generation = 0;
  private fatalStopped = false;
  private failures = 0;
  private terminating: Promise<void> | null = null;
  private terminationError: Error | null = null;
  private replacing = false;
  private identity: { scope: string; agent: string } | null = null;
  private startedVersion: string | null = null;
  private expectedVersion: string | null = null;
  private handoffs: number[] = [];
  private delivered = new Set<string>();
  private pending = new Set<string>();

  constructor(private readonly config: WatchClientConfig) {}

  start(): void {
    if (this.fatalStopped || this.running || this.terminating || this.child) return;
    this.running = true;
    this.spawnProcess();
  }

  isRunning(): boolean { return this.running; }

  async stop(): Promise<void> {
    this.running = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try { await this.terminateChild(); }
    catch (error) {
      this.fail(`watch stop blocked: ${String(error)}`);
      throw error;
    }
  }

  private report(detail: string): void {
    console.error(`[eigenflux:watch] ${detail}`);
    void this.config.onDiagnostic(detail).catch((error) => console.error('[eigenflux:watch] diagnostic delivery failed', String(error)));
  }

  private spawnProcess(): void {
    if (!this.running || this.child || this.terminating) return;
    this.startedVersion = null;
    const spawnFn = this.config.spawnFn ?? (spawn as unknown as SpawnFn);
    let child: ChildProcess;
    try {
      child = spawnFn(this.config.eigenfluxBin, [
        '--homedir', this.config.eigenfluxHome, '--server', this.config.serverName, 'watch',
      ], { stdio: ['ignore', 'pipe', 'pipe'], env: cliChildEnv() });
    } catch (error) {
      this.report(`spawn failed: ${String(error)}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    const reader = createInterface({ input: child.stdout! });
    this.reader = reader;
    reader.on('line', (line) => {
      if (this.running && this.child === child && !this.replacing) this.handleLine(line);
    });
    child.stderr?.on('data', (chunk) => console.error(`[eigenflux:watch] ${String(chunk).trim()}`));
    let ended = false;
    const onEnd = () => {
      if (ended) return;
      ended = true;
      reader.close();
      if (this.child === child) {
        this.child = null;
        this.reader = null;
      }
      if (!this.replacing && !this.terminating) this.scheduleRestart();
    };
    child.once('exit', (code) => {
      const fatal = code === 78 && this.running;
      if (fatal) this.running = false;
      onEnd();
      if (fatal) this.rejectIdentity();
    });
    child.once('error', (error) => {
      this.report(`process error: ${error.message}`);
      // A spawn failure has no process to wait for; errors from live processes
      // must not create a second consumer while the old process is still alive.
      if (!child.pid) onEnd();
    });
  }

  private scheduleRestart(): void {
    if (!this.running || this.timer) return;
    if (++this.failures >= (this.config.maxFailures ?? 20)) {
      this.fail('watch stopped after repeated failures');
      return;
    }
    const delay = Math.min((this.config.retryMs ?? 1000) * 2 ** (this.failures - 1), 60_000);
    this.timer = setTimeout(() => { this.timer = null; this.spawnProcess(); }, delay);
  }

  private terminateChild(): Promise<void> {
    if (this.terminating) return this.terminating;
    const child = this.child;
    if (!child) return Promise.resolve();
    if (this.terminationError) return Promise.reject(this.terminationError);
    this.reader?.close();
    const grace = this.config.stopGraceMs ?? 5000;
    const task = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('exit', exited);
        if (error) reject(error); else resolve();
      };
      const exited = () => finish();
      child.once('exit', exited);
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* Await confirmed exit below. */ }
        if (!settled) timer = setTimeout(() => finish(new Error('watch exit could not be confirmed after SIGTERM/SIGKILL')), grace);
      }, grace);
      try { child.kill('SIGTERM'); } catch { /* Exit confirmation is still required. */ }
    });
    this.terminating = task.catch((error: Error) => {
      this.terminationError = error;
      throw error;
    }).finally(() => { this.terminating = null; });
    return this.terminating;
  }

  private rejectIdentity(): void {
    const detail = 'watch identity or configuration changed; stopped until the host is restarted';
    this.fail(detail);
  }

  private fail(detail: string): void {
    if (this.fatalStopped) return;
    this.fatalStopped = true;
    this.running = false;
    this.generation++;
    this.report(detail);
    try {
      void this.config.onFatal?.(detail).catch((error) => this.report(String(error)));
    } catch (error) { this.report(String(error)); }
    void this.stop().catch((error) => this.report(String(error)));
  }

  private handleLine(line: string): void {
    let event: WatchEvent;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || event.schema_version !== 'eigenflux_watch.v1' || typeof event.state_scope !== 'string' || !event.state_scope || typeof event.event_id !== 'string' || !event.event_id || !TYPES.has(event.type) || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return;
    if (event.type === 'started') {
      const data = event.data;
      if (typeof data.home !== 'string' || normalizeHome(data.home) !== normalizeHome(this.config.eigenfluxHome) || data.server !== this.config.serverName || typeof data.agent_id !== 'string' || !data.agent_id || typeof data.cli_version !== 'string' || !data.cli_version || (this.expectedVersion && this.expectedVersion !== data.cli_version)) {
        this.rejectIdentity(); return;
      }
      if (this.identity && (this.identity.scope !== event.state_scope || this.identity.agent !== data.agent_id)) {
        this.rejectIdentity(); return;
      }
      this.identity = { scope: event.state_scope, agent: data.agent_id };
      this.startedVersion = data.cli_version;
      return;
    }
    if (!this.startedVersion || !this.identity) return;
    if (event.state_scope !== this.identity.scope) { this.rejectIdentity(); return; }
    if (event.type === 'runtime_ready') {
      const data = event.data;
      if (data.cli_version !== this.startedVersion || data.agent_id !== this.identity.agent || data.server !== this.config.serverName || typeof data.home !== 'string' || normalizeHome(data.home) !== normalizeHome(this.config.eigenfluxHome)) {
        this.rejectIdentity(); return;
      }
      this.failures = 0;
      this.expectedVersion = null;
      console.error(`[eigenflux:watch] runtime ready, CLI ${this.startedVersion}`);
      return;
    }
    if (event.type === 'diagnostic' && ['identity_changed', 'configuration_changed', 'owner_replaced'].includes(String(event.data.code))) {
      this.rejectIdentity(); return;
    }
    if (event.type === 'restart_required') {
      const version = event.data.cli_version;
      if (typeof version === 'string' && version && version !== this.startedVersion) void this.replaceProcess(version);
      return;
    }
    const key = `${event.state_scope}:${event.event_id}`;
    if (this.delivered.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    const generation = this.generation;
    void Promise.resolve().then(async () => {
      if (!this.running || generation !== this.generation) return;
      await this.config.onEvent(event);
      this.delivered.add(key);
      if (this.delivered.size > 512) this.delivered.delete(this.delivered.values().next().value!);
    }).catch((error) => this.report(`event delivery failed: ${String(error)}`)).finally(() => this.pending.delete(key));
  }

  private async replaceProcess(version: string): Promise<void> {
    if (this.replacing || !this.running) return;
    this.handoffs = this.handoffs.filter((time) => Date.now() - time < 60_000);
    if (this.handoffs.length >= 3) {
      this.fail('watch replacement limit reached');
      return;
    }
    this.handoffs.push(Date.now());
    this.replacing = true;
    this.expectedVersion = version;
    try {
      await this.terminateChild();
      if (this.running) this.spawnProcess();
    } catch (error) {
      this.fail(`watch replacement blocked: ${String(error)}`);
    } finally { this.replacing = false; }
  }
}
