import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { LeaderElector } from './instance-leader.js';

function tmpSock(): string {
  // Keep the path short — unix socket paths are capped at ~104 bytes on darwin.
  return path.join(os.tmpdir(), `ef-lead-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

interface Harness {
  elector: LeaderElector;
  acquired: number;
  released: number;
}

function makeElector(
  sockPath: string,
  priority: number,
  retryMs = 100,
  extra: Record<string, unknown> = {},
): Harness {
  const h: Partial<Harness> = { acquired: 0, released: 0 };
  h.elector = new LeaderElector({
    sockPath,
    priority,
    retryMs,
    preemptRetryMs: 50,
    onAcquire: () => { h.acquired!++; },
    onRelease: () => { h.released!++; },
    ...extra,
  });
  return h as Harness;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function register(sockPath: string, ...harnesses: Harness[]): void {
  cleanups.push(() => {
    for (const h of harnesses) h.elector.stop();
    try { fs.unlinkSync(sockPath); } catch { /* gone */ }
  });
}

describe('LeaderElector', () => {
  test('first instance acquires leadership', async () => {
    const sock = tmpSock();
    const a = makeElector(sock, 1);
    register(sock, a);

    a.elector.start();
    await waitFor(() => a.elector.isLeader);
    expect(a.acquired).toBe(1);
  });

  test('equal priority does not preempt; standby takes over after leader stops', async () => {
    const sock = tmpSock();
    const a = makeElector(sock, 1);
    const b = makeElector(sock, 1);
    register(sock, a, b);

    a.elector.start();
    await waitFor(() => a.elector.isLeader);

    b.elector.start();
    // Give b time to probe and settle into standby.
    await new Promise((r) => setTimeout(r, 300));
    expect(b.elector.isLeader).toBe(false);
    expect(a.elector.isLeader).toBe(true);

    // Leader exits — standby takes over on its next retry.
    a.elector.stop();
    await waitFor(() => b.elector.isLeader);
    expect(b.acquired).toBe(1);
  });

  test('higher-priority instance preempts a lower-priority leader', async () => {
    const sock = tmpSock();
    const low = makeElector(sock, 1);
    const high = makeElector(sock, 2);
    register(sock, low, high);

    low.elector.start();
    await waitFor(() => low.elector.isLeader);

    high.elector.start();
    await waitFor(() => high.elector.isLeader);
    expect(low.elector.isLeader).toBe(false);
    expect(low.released).toBe(1);

    // The abdicated leader goes standby, and reclaims after the winner exits.
    high.elector.stop();
    await waitFor(() => low.elector.isLeader);
    expect(low.acquired).toBe(2);
  });

  test('stale socket from a dead leader is cleaned up and claimed', async () => {
    const sock = tmpSock();
    // Simulate a leader that was SIGKILLed: socket file exists, nobody listens.
    const dead = makeElector(sock, 1);
    dead.elector.start();
    await waitFor(() => dead.elector.isLeader);
    // Emulate a hard kill: drop the server reference without unlinking.
    // stop() unlinks, so instead re-create the stale file after stopping.
    dead.elector.stop();
    fs.writeFileSync(sock, '');

    const b = makeElector(sock, 1);
    register(sock, dead, b);
    b.elector.start();
    await waitFor(() => b.elector.isLeader);
    expect(b.acquired).toBe(1);
  });

  test('frozen holder (fd open, never responds) is reclaimed after repeated timeouts', async () => {
    const sock = tmpSock();
    // Simulate a SIGSTOP'd leader: the listening socket is real, so connect()
    // succeeds into the kernel backlog, but nothing ever services the
    // connection — no 'LEADER' line ever arrives, mirroring a process frozen
    // by shell job control rather than one that actually exited.
    const frozen = net.createServer();
    await new Promise<void>((resolve, reject) => {
      frozen.once('error', reject);
      frozen.listen(sock, () => resolve());
    });

    const b = makeElector(sock, 1, 50, { probeTimeoutMs: 50, staleAfterStrikes: 2 });
    register(sock, b);
    b.elector.start();
    // Two probe cycles at ~50ms timeout + ~50ms retry each — bounded, not the
    // old infinite standby.
    await waitFor(() => b.elector.isLeader, 3_000);
    expect(b.acquired).toBe(1);

    frozen.close();
  });
});
