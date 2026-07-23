import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  PmStreamClient,
  EXIT_AUTH_REQUIRED,
  type SpawnFn,
} from './pm-stream.js';

/**
 * Fake child process driving the REAL PmStreamClient: emit NDJSON lines on
 * stdout, then exit with a chosen code. Replaces the old tests/pm-stream
 * harness that re-implemented the state machine and could silently drift
 * from the implementation.
 */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(_signal?: string): boolean {
    this.killed = true;
    // Simulate the process dying promptly on SIGTERM.
    setImmediate(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }
}

interface Harness {
  client: PmStreamClient;
  spawns: Array<{ args: string[]; child: FakeChild }>;
  pmEvents: unknown[];
  authCalls: number;
}

function makeHarness(overrides: Partial<ConstructorParameters<typeof PmStreamClient>[0]> = {}): Harness {
  const spawns: Harness['spawns'] = [];
  const pmEvents: unknown[] = [];
  const h: Harness = { client: null as unknown as PmStreamClient, spawns, pmEvents, authCalls: 0 };

  const spawnFn: SpawnFn = (_bin, args) => {
    const child = new FakeChild();
    spawns.push({ args, child });
    return child as unknown as ChildProcess;
  };

  h.client = new PmStreamClient({
    serverName: 'srv',
    eigenfluxBin: 'eigenflux',
    async onPmEvent(event) { pmEvents.push(event); },
    async onAuthRequired() { h.authCalls += 1; },
    spawnFn,
    // Fast timings so restart chains run in milliseconds.
    initialBackoffMs: 5,
    maxBackoffMs: 20,
    stopGraceMs: 50,
    ...overrides,
  });
  return h;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('spawns `stream -s <server> -f json` and delivers parsed events', async () => {
  const h = makeHarness();
  h.client.start();
  expect(h.spawns.length).toBe(1);
  expect(h.spawns[0].args).toEqual(['stream', '-s', 'srv', '-f', 'json']);

  h.spawns[0].child.stdout.write(JSON.stringify({ type: 'pm', data: { messages: [] } }) + '\n');
  await settle(10);
  expect(h.pmEvents.length).toBe(1);
  await h.client.stop();
});

test('captures next_cursor and resumes reconnects with --cursor', async () => {
  const h = makeHarness();
  h.client.start();
  h.spawns[0].child.stdout.write(JSON.stringify({ type: 'pm', data: { next_cursor: 'c-42' } }) + '\n');
  await settle(10);
  expect(h.client.getLastCursor()).toBe('c-42');

  h.spawns[0].child.emit('exit', 1, null);
  await settle(30);
  expect(h.spawns.length).toBe(2);
  expect(h.spawns[1].args).toEqual(['stream', '-s', 'srv', '-f', 'json', '--cursor', 'c-42']);
  await h.client.stop();
});

test('malformed lines are skipped without delivering events', async () => {
  const h = makeHarness();
  h.client.start();
  h.spawns[0].child.stdout.write('not-json{{{\n\n');
  await settle(10);
  expect(h.pmEvents.length).toBe(0);
  await h.client.stop();
});

test('exit code 4 calls onAuthRequired and still reconnects', async () => {
  const h = makeHarness();
  h.client.start();
  h.spawns[0].child.emit('exit', EXIT_AUTH_REQUIRED, null);
  await settle(30);
  expect(h.authCalls).toBe(1);
  expect(h.spawns.length).toBe(2);
  await h.client.stop();
});

test('gives up after maxConsecutiveFailures and stops running', async () => {
  const h = makeHarness({ maxConsecutiveFailures: 3 });
  h.client.start();
  for (let i = 0; i < 3; i++) {
    h.spawns[h.spawns.length - 1].child.emit('exit', 1, null);
    await settle(30);
  }
  expect(h.client.isRunning()).toBe(false);
  // 3rd failure hits the cap: no further respawn beyond the 3 spawned.
  expect(h.spawns.length).toBe(3);
});

test('a successful message resets the failure count', async () => {
  const h = makeHarness({ maxConsecutiveFailures: 3 });
  h.client.start();
  // Two failures, then a good message, then two more failures — without the
  // reset the 3rd overall failure would hit the cap.
  h.spawns[0].child.emit('exit', 1, null);
  await settle(30);
  h.spawns[1].child.emit('exit', 1, null);
  await settle(30);
  h.spawns[2].child.stdout.write(JSON.stringify({ type: 'pm', data: {} }) + '\n');
  await settle(10);
  h.spawns[2].child.emit('exit', 1, null);
  await settle(30);
  expect(h.client.isRunning()).toBe(true);
  expect(h.spawns.length).toBe(4);
  await h.client.stop();
});

test('stop() terminates the child and suppresses restarts', async () => {
  const h = makeHarness();
  h.client.start();
  const child = h.spawns[0].child;
  await h.client.stop();
  expect(child.killed).toBe(true);
  await settle(30);
  expect(h.spawns.length).toBe(1);
  expect(h.client.isRunning()).toBe(false);
});
