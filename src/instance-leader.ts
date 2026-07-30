/**
 * Single-instance leader election for the EigenFlux channel plugin.
 *
 * Claude Code spawns one MCP server per session, so a user with many open
 * sessions gets many plugin instances — each polling the feed and streaming
 * PMs. Only sessions launched with the channel enabled can actually deliver
 * notifications; every other instance's pushes are dropped by the host
 * ("not in --channels"), and its polls are pure waste.
 *
 * This module elects exactly ONE leader per machine via a unix-domain-socket
 * lock. Only the leader runs the background loops (feed poller, PM stream,
 * profile refresher, feedback flush). Everyone else stays standby and
 * periodically retries, so leadership fails over when the leader's session
 * exits.
 *
 * Priority: an instance whose ancestor `claude` process was launched with
 * `--dangerously-load-development-channels` naming this plugin outranks
 * ordinary instances. A higher-priority challenger causes the current leader
 * to abdicate (stop loops, release the socket) so the channel-enabled session
 * takes over. Equal priority never preempts — first holder wins.
 *
 * Protocol (newline-delimited, over the lock socket):
 *   leader:  "LEADER <priority>\n"   sent on accept
 *   peer:    "PEER <priority>\n"     reply, then close
 * A leader that reads a peer priority greater than its own abdicates.
 *
 * Stale-lock reclamation: a leader whose process exits cleanly closes the fd,
 * so a standby's connect() gets ECONNREFUSED and reclaims immediately. But a
 * leader whose process is merely *frozen* (e.g. shell job control SIGSTOP's
 * it when the user backgrounds the terminal tab) still holds the fd open —
 * the kernel accepts the standby's connect() into the listen backlog even
 * though nothing will ever call accept()/write() on it, so the standby sees
 * a connect *timeout*, not a connect *error*. A single timeout is therefore
 * ambiguous (could be a slow GC pause) and is not treated as stale; only
 * `staleAfterStrikes` *consecutive* timeouts — with no successful handshake
 * in between — are treated as a dead-equivalent leader and reclaimed the
 * same way as a confirmed ECONNREFUSED.
 *
 * All logging goes through the injected `log` (stderr in the plugin).
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const PRIORITY_DEV_CHANNEL = 2;
export const PRIORITY_DEFAULT = 1;

const DEV_CHANNEL_FLAG = '--dangerously-load-development-channels';

/**
 * Walk up the process tree looking for an ancestor launched with the
 * dev-channels flag that names this plugin. Returns the election priority.
 *
 * `EIGENFLUX_LEADER_PRIORITY` overrides detection (useful in tests and as an
 * operator escape hatch).
 */
export function detectLeaderPriority(pluginName = 'eigenflux', maxDepth = 10): number {
  const override = process.env.EIGENFLUX_LEADER_PRIORITY;
  if (override !== undefined) {
    const n = parseInt(override, 10);
    if (Number.isFinite(n)) return n;
  }

  let pid = process.ppid;
  for (let depth = 0; depth < maxDepth && pid > 1; depth++) {
    let line: string;
    try {
      line = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim();
    } catch {
      return PRIORITY_DEFAULT;
    }
    const m = line.match(/^\s*(\d+)\s+(.*)$/s);
    if (!m) return PRIORITY_DEFAULT;
    const [, ppidStr, command] = m;
    if (command.includes(DEV_CHANNEL_FLAG) && command.includes(pluginName)) {
      return PRIORITY_DEV_CHANNEL;
    }
    pid = Number(ppidStr);
  }
  return PRIORITY_DEFAULT;
}

export interface LeaderElectorOptions {
  sockPath: string;
  priority: number;
  onAcquire: () => void;
  /** Must stop all background loops; awaited before the retry loop resumes. */
  onRelease: () => Promise<void> | void;
  log?: (msg: string) => void;
  /** Standby retry interval; also the failover detection latency. */
  retryMs?: number;
  /** Retry interval right after asking a lower-priority leader to abdicate. */
  preemptRetryMs?: number;
  /** How long a single probe waits for the holder to respond before counting it as a timeout strike. */
  probeTimeoutMs?: number;
  /** Consecutive probe timeouts (no successful handshake in between) before the lock is treated as stale and reclaimed. */
  staleAfterStrikes?: number;
}

export class LeaderElector {
  private readonly opts: Required<LeaderElectorOptions>;
  private server: net.Server | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private abdicating = false;
  /** Consecutive unanswered probes against the current holder; reset on any successful handshake. */
  private staleStrikes = 0;

  constructor(opts: LeaderElectorOptions) {
    this.opts = {
      log: () => {},
      retryMs: 15_000,
      preemptRetryMs: 2_000,
      probeTimeoutMs: 3_000,
      staleAfterStrikes: 2,
      ...opts,
    };
  }

  get isLeader(): boolean {
    return this.server !== null;
  }

  start(): void {
    this.stopped = false;
    fs.mkdirSync(path.dirname(this.opts.sockPath), { recursive: true });
    this.attempt();
  }

  /** Stop contending; if leading, release the socket (loops are the caller's
   *  to stop via its own shutdown path). */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.closeServer();
  }

  private closeServer(): void {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    server.close();
    try { fs.unlinkSync(this.opts.sockPath); } catch { /* already gone */ }
  }

  private scheduleRetry(delayMs: number): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.attempt();
    }, delayMs);
  }

  private attempt(): void {
    if (this.stopped || this.server) return;

    const server = net.createServer((conn) => this.handlePeer(conn));
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (this.server === server) {
        // Listening server died unexpectedly — drop leadership and re-contend.
        this.opts.log(`[eigenflux:leader] lock socket error while leading: ${err.message}`);
        this.server = null;
        void this.abdicate('socket error');
        return;
      }
      if (err.code === 'EADDRINUSE') {
        this.probeHolder();
      } else {
        this.opts.log(`[eigenflux:leader] listen failed: ${err.message}`);
        this.scheduleRetry(this.opts.retryMs);
      }
    });
    server.listen(this.opts.sockPath, () => {
      this.server = server;
      this.opts.log(`[eigenflux:leader] leadership acquired (priority=${this.opts.priority})`);
      this.opts.onAcquire();
    });
  }

  /** Socket exists — ask the holder who it is; clean up if it's stale. */
  private probeHolder(): void {
    const conn = net.connect(this.opts.sockPath);
    let leaderPriority: number | null = null;
    let buffer = '';
    conn.setTimeout(this.opts.probeTimeoutMs);

    const finish = (retryMs: number) => {
      conn.destroy();
      this.scheduleRetry(retryMs);
    };

    // Nobody home: the previous holder is gone or unresponsive. Remove the
    // stale socket and re-contend immediately. If two standbys race here,
    // the loser just hits EADDRINUSE and goes back to standby.
    const reclaimStale = (reason: string) => {
      this.opts.log(`[eigenflux:leader] standby: reclaiming stale lock (${reason})`);
      try { fs.unlinkSync(this.opts.sockPath); } catch { /* raced */ }
      conn.destroy();
      this.staleStrikes = 0;
      if (!this.stopped) this.attempt();
    };

    conn.on('data', (chunk) => {
      this.staleStrikes = 0;
      buffer += chunk.toString();
      const line = buffer.split('\n')[0];
      if (!buffer.includes('\n')) return;
      const m = line?.match(/^LEADER (-?\d+)$/);
      leaderPriority = m ? parseInt(m[1]!, 10) : null;
      conn.write(`PEER ${this.opts.priority}\n`);
      if (leaderPriority !== null && this.opts.priority > leaderPriority) {
        // Holder will abdicate on reading our priority — retry soon.
        this.opts.log(`[eigenflux:leader] standby: preempting lower-priority leader (${leaderPriority} < ${this.opts.priority})`);
        finish(this.opts.preemptRetryMs);
      } else {
        finish(this.opts.retryMs);
      }
    });
    conn.on('timeout', () => {
      // Connect() can succeed into the kernel backlog even when the holder
      // process can't run at all (e.g. SIGSTOP'd) — that reads as a silent
      // timeout here, not a connection error. One timeout is ambiguous (could
      // be a slow GC pause); only sustained silence across consecutive probes
      // is treated as dead-equivalent.
      this.staleStrikes++;
      if (this.staleStrikes >= this.opts.staleAfterStrikes) {
        reclaimStale(`${this.staleStrikes} consecutive unresponsive probes`);
        return;
      }
      finish(this.opts.retryMs);
    });
    conn.on('error', () => reclaimStale('connection refused'));
  }

  /** Leader side of the handshake. */
  private handlePeer(conn: net.Socket): void {
    let buffer = '';
    conn.setTimeout(3_000);
    conn.write(`LEADER ${this.opts.priority}\n`);
    conn.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      const m = buffer.split('\n')[0]?.match(/^PEER (-?\d+)$/);
      conn.end();
      if (m && parseInt(m[1]!, 10) > this.opts.priority) {
        void this.abdicate(`higher-priority peer (${m[1]})`);
      }
    });
    conn.on('timeout', () => conn.destroy());
    conn.on('error', () => conn.destroy());
  }

  private async abdicate(reason: string): Promise<void> {
    if (this.abdicating) return;
    this.abdicating = true;
    try {
      this.opts.log(`[eigenflux:leader] abdicating: ${reason}`);
      this.closeServer();
      await this.opts.onRelease();
    } finally {
      this.abdicating = false;
    }
    // Back to standby: if the challenger dies later, we can lead again.
    this.scheduleRetry(this.opts.retryMs);
  }
}
