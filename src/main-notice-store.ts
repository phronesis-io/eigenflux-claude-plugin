/** Same-session asyncRewake handoff. Keep MAIN_NOTICE.md current when changing this contract. */
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { CONFIG } from './config.js';

export const MAIN_NOTICE_CAPABILITY = 'ai.eigenflux.mainConversation';
export const MAIN_NOTICE_HOST = 'claude-code';
export const MAIN_NOTICE_MAX_BYTES = 32 * 1024;
export const MAIN_NOTICE_LEASE_MS = 6000;
export const MAIN_NOTICE_WAIT_MS = 180_000;
export const MAIN_NOTICE_HOOK_MS = 24 * 60 * 60 * 1000;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const cleanText = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);

export class MainNoticeError extends Error {
  constructor(public readonly reason: string) { super(reason); }
}
export interface MainNoticeTarget { sessionId: string; cwd: string }
export interface MainNoticeRequest extends MainNoticeTarget { requestId: string; prompt: string }
export interface MainNoticeHookInput {
  session_id: string; cwd: string; hook_event_name: string;
  prompt?: string; last_assistant_message?: string;
}
interface SessionRow {
  target: string; session_id: string; cwd: string; listener: string;
  listener_pid: number; generation: string; state: string; lease: number;
  baseline_hash: string; active_request: string | null;
}
interface RequestRow {
  request_id: string; target: string; generation: string; phase: string;
  prompt: string; wake_text: string; deadline: number; baseline_hash: string;
  caller_pid: number; text: string | null;
}
export interface MainNoticeReceipt extends MainNoticeTarget {
  host: string; existingSession: true; hiddenInput: true; resultOnly: true;
  state: 'idle'; requestId?: string; runId?: string; stopReason?: 'end_turn'; text?: string;
}

export function mainNoticeDatabasePath(): string {
  const override = process.env.EIGENFLUX_MAIN_BRIDGE_HOME;
  if (override && !isAbsolute(override)) throw new MainNoticeError('main_bridge_home_invalid');
  return join(override || join(CONFIG.EIGENFLUX_HOME, 'claude-main-notice'), 'bridge.sqlite');
}
function targetKey(target: MainNoticeTarget): string {
  if (!cleanText(target.sessionId, 200) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(target.sessionId)
    || !isAbsolute(target.cwd) || !cleanText(target.cwd, 8192)) {
    throw new MainNoticeError('main_session_binding_invalid');
  }
  // A physical directory is part of the binding; never fall back to another cwd/session.
  if (realpathSync(target.cwd) !== target.cwd) throw new MainNoticeError('main_session_cwd_mismatch');
  return hash(`${target.sessionId}\0${target.cwd}`);
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function mainNoticeWakeText(requestId: string, nonce: string, prompt: string): string {
  // Host delivery only; business instructions remain in the CLI-supplied prompt/central Skills.
  return `EigenFlux main-conversation event ${requestId}; receipt ${nonce}.\n`
    + 'This is background context, not a human message. Process it in this conversation. '
    + 'Show only the result; do not quote this context or its receipt.\n' + prompt;
}

export class MainNoticeStore {
  private readonly db: Database;
  constructor(readonly file = mainNoticeDatabasePath()) {
    const parent = dirname(file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const dir = lstatSync(parent);
    if (dir.isSymbolicLink() || !dir.isDirectory()) throw new MainNoticeError('main_bridge_directory_invalid');
    if (process.platform !== 'win32' && (dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0)) {
      throw new MainNoticeError('main_bridge_directory_not_private');
    }
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32'
        && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
        throw new MainNoticeError('main_bridge_database_not_private');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // DELETE journaling keeps private-data sidecars short lived; no credential or transcript reads.
    this.db = new Database(file, { create: true });
    chmodSync(file, 0o600);
    this.db.exec('PRAGMA busy_timeout = 500; PRAGMA journal_mode = DELETE;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS main_sessions (
      target TEXT PRIMARY KEY, session_id TEXT NOT NULL, cwd TEXT NOT NULL,
      listener TEXT NOT NULL, listener_pid INTEGER NOT NULL, generation TEXT NOT NULL,
      state TEXT NOT NULL, lease INTEGER NOT NULL, baseline_hash TEXT NOT NULL,
      active_request TEXT);
      CREATE TABLE IF NOT EXISTS main_requests (
      request_id TEXT PRIMARY KEY, target TEXT NOT NULL, generation TEXT NOT NULL,
      phase TEXT NOT NULL, prompt TEXT NOT NULL, wake_text TEXT NOT NULL,
      deadline INTEGER NOT NULL, baseline_hash TEXT NOT NULL, caller_pid INTEGER NOT NULL, text TEXT);`);
  }
  close(): void { this.db.close(); }
  failClosed(): void {
    this.transaction(() => {
      this.db.query("UPDATE main_requests SET phase='unknown',prompt='',wake_text='' WHERE phase IN ('queued','injected')").run();
      this.db.query("UPDATE main_sessions SET state='closed',lease=0,active_request=NULL").run();
    });
  }
  private transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  private session(target: string): SessionRow | null {
    return this.db.query<SessionRow, [string]>('SELECT * FROM main_sessions WHERE target=?').get(target);
  }
  private request(id: string): RequestRow | null {
    return this.db.query<RequestRow, [string]>('SELECT * FROM main_requests WHERE request_id=?').get(id);
  }
  private invalidate(session: SessionRow): void {
    if (session.active_request) {
      this.db.query("UPDATE main_requests SET phase='unknown',prompt='',wake_text='' WHERE request_id=? AND phase IN ('queued','injected')")
        .run(session.active_request);
    }
    this.db.query('UPDATE main_sessions SET active_request=NULL WHERE target=?').run(session.target);
  }
  inspect(target: MainNoticeTarget, now = Date.now()): MainNoticeReceipt {
    const row = this.session(targetKey(target));
    if (!row || row.state !== 'idle' || row.active_request || row.lease <= now || !alive(row.listener_pid)) {
      throw new MainNoticeError('main_session_not_idle_or_unavailable');
    }
    return { ...target, host: MAIN_NOTICE_HOST, state: 'idle', existingSession: true, hiddenInput: true, resultOnly: true };
  }
  /** Called only by Claude's own hooks, using their stdin session/cwd. No session guessing. */
  observe(input: MainNoticeHookInput): void {
    const key = targetKey({ sessionId: input.session_id, cwd: input.cwd });
    this.transaction(() => {
      const session = this.session(key);
      if (!session) return;
      if (input.hook_event_name === 'UserPromptSubmit') {
        const pending = session.active_request ? this.request(session.active_request) : null;
        // Some host versions may echo the exact reminder through UserPromptSubmit.
        // Every other prompt invalidates attribution; do not copy/retain the human's text.
        if (!pending || pending.phase !== 'injected' || input.prompt !== pending.wake_text) this.invalidate(session);
        this.db.query("UPDATE main_sessions SET state='busy',lease=0 WHERE target=?").run(key);
      } else if (input.hook_event_name === 'Stop') {
        const pending = session.active_request ? this.request(session.active_request) : null;
        const text = input.last_assistant_message;
        const completed = pending && pending.phase === 'injected' && pending.generation === session.generation
          && pending.deadline > Date.now() && cleanText(text, MAIN_NOTICE_MAX_BYTES)
          && hash(text) !== pending.baseline_hash;
        if (completed) {
          this.db.query("UPDATE main_requests SET phase='completed',text=?,prompt='',wake_text='' WHERE request_id=?")
            .run(text!, pending.request_id);
        } else this.invalidate(session);
        this.db.query("UPDATE main_sessions SET state='idle',lease=0,active_request=NULL,baseline_hash=? WHERE target=?")
          .run(typeof text === 'string' ? hash(text) : '', key);
      } else if (input.hook_event_name === 'SessionEnd' || input.hook_event_name === 'StopFailure') {
        this.invalidate(session);
        this.db.query("UPDATE main_sessions SET state='closed',lease=0 WHERE target=?").run(key);
      }
    });
  }
  listen(input: MainNoticeHookInput, now = Date.now()): string {
    const key = targetKey({ sessionId: input.session_id, cwd: input.cwd });
    const listener = randomUUID();
    this.transaction(() => {
      const old = this.session(key);
      if (old && input.hook_event_name === 'SessionStart') this.invalidate(old);
      if (old?.active_request && input.hook_event_name !== 'SessionStart') throw new MainNoticeError('main_session_busy');
      const generation = input.hook_event_name === 'SessionStart' || !old ? randomUUID() : old.generation;
      const baseline = typeof input.last_assistant_message === 'string' ? hash(input.last_assistant_message) : old?.baseline_hash || '';
      this.db.query(`INSERT INTO main_sessions VALUES (?,?,?,?,?,?, 'idle',?,?,NULL)
        ON CONFLICT(target) DO UPDATE SET listener=excluded.listener,listener_pid=excluded.listener_pid,
        generation=excluded.generation,state='idle',lease=excluded.lease,baseline_hash=excluded.baseline_hash,active_request=NULL`)
        .run(key, input.session_id, input.cwd, listener, process.pid, generation, now + MAIN_NOTICE_LEASE_MS, baseline);
    });
    return listener;
  }
  /** The lease holder claims once before writing stderr/exit 2. Never claims expired requests. */
  tick(target: MainNoticeTarget, listener: string, now = Date.now()): { active: boolean; wake?: string } {
    return this.transaction(() => {
      const key = targetKey(target);
      const session = this.session(key);
      if (!session || session.listener !== listener || session.state !== 'idle') return { active: false };
      this.db.query('UPDATE main_sessions SET lease=? WHERE target=?').run(now + MAIN_NOTICE_LEASE_MS, key);
      if (!session.active_request) return { active: true };
      const pending = this.request(session.active_request);
      if (!pending || pending.phase !== 'queued' || pending.deadline <= now || pending.generation !== session.generation || !alive(pending.caller_pid)) {
        this.invalidate(session);
        return { active: true };
      }
      this.db.query("UPDATE main_requests SET phase='injected' WHERE request_id=?").run(pending.request_id);
      this.db.query("UPDATE main_sessions SET state='busy',lease=0 WHERE target=?").run(key);
      return { active: false, wake: pending.wake_text };
    });
  }
  stopListening(target: MainNoticeTarget, listener: string): void {
    this.db.query('UPDATE main_sessions SET lease=0 WHERE target=? AND listener=?').run(targetKey(target), listener);
  }
  admit(input: MainNoticeRequest, waitMs = MAIN_NOTICE_WAIT_MS, now = Date.now()): void {
    if (!cleanText(input.requestId, 128) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(input.requestId)
      || !cleanText(input.prompt, MAIN_NOTICE_MAX_BYTES) || waitMs < 1 || waitMs > MAIN_NOTICE_WAIT_MS) {
      throw new MainNoticeError('main_notice_request_invalid');
    }
    this.transaction(() => {
      const key = targetKey(input);
      // A duplicate is never inserted, resumed, or resent, including after a restart.
      if (this.request(input.requestId)) throw new MainNoticeError('main_notice_already_attempted');
      this.inspect(input, now);
      const session = this.session(key)!;
      if (session.active_request) throw new MainNoticeError('main_session_busy');
      const nonce = randomUUID();
      this.db.query(`INSERT INTO main_requests VALUES (?,?,?,'queued',?,?,?,?,?,NULL)`)
        .run(input.requestId, key, session.generation, input.prompt,
          mainNoticeWakeText(input.requestId, nonce, input.prompt), now + waitMs, session.baseline_hash, process.pid);
      this.db.query('UPDATE main_sessions SET active_request=? WHERE target=?').run(input.requestId, key);
    });
  }
  receipt(input: MainNoticeRequest): MainNoticeReceipt | null {
    const row = this.request(input.requestId);
    if (!row || row.target !== targetKey(input)) throw new MainNoticeError('main_notice_receipt_mismatch');
    if (row.phase === 'unknown' || row.phase === 'cancelled') throw new MainNoticeError('main_notice_result_unknown');
    if (row.phase !== 'completed') return null;
    return { sessionId: input.sessionId, cwd: input.cwd, host: MAIN_NOTICE_HOST, state: 'idle',
      existingSession: true, hiddenInput: true, resultOnly: true, requestId: input.requestId,
      runId: row.generation + ':' + input.requestId, stopReason: 'end_turn', text: row.text! };
  }
  abandon(input: MainNoticeRequest): void {
    this.transaction(() => {
      const key = targetKey(input);
      const row = this.request(input.requestId);
      if (!row || row.target !== key || row.phase === 'completed') return;
      this.db.query("UPDATE main_requests SET phase='unknown',prompt='',wake_text='' WHERE request_id=?")
        .run(input.requestId);
      this.db.query('UPDATE main_sessions SET active_request=NULL WHERE target=? AND active_request=?')
        .run(key, input.requestId);
    });
  }
}
