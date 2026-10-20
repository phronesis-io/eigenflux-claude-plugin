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
    setImmediate(() => { this.emit('exit', null, 'SIGTERM'); this.emit('close', null, 'SIGTERM'); });
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

  h.spawns[0].child.emit('close', 1, null);
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
  h.spawns[0].child.emit('close', EXIT_AUTH_REQUIRED, null);
  await settle(30);
  expect(h.authCalls).toBe(1);
  expect(h.spawns.length).toBe(2);
  await h.client.stop();
});

test('authentication diagnostics include chunks drained after process exit', async () => {
  const details: string[] = [];
  const h = makeHarness({ onAuthRequired: async (detail) => { details.push(detail); } });
  h.client.start();
  const child = h.spawns[0].child;
  const diagnostic = 'warning\n{"owner_action":"请恢复原账号"}\n';
  const encoded = Buffer.from(diagnostic);
  const split = encoded.indexOf(Buffer.from('请')) + 1;
  child.stderr.write(encoded.subarray(0, split));
  child.emit('exit', EXIT_AUTH_REQUIRED, null);
  await settle(1);
  expect(details).toEqual([]);
  child.stderr.write(encoded.subarray(split));
  child.emit('close', EXIT_AUTH_REQUIRED, null);
  await settle(1);
  expect(details).toEqual([diagnostic.trim()]);
  await h.client.stop();
});

test('spawn errors followed by close schedule only one restart', async () => {
  const h = makeHarness();
  h.client.start();
  h.spawns[0].child.emit('error', Object.assign(new Error('missing CLI'), { code: 'ENOENT' }));
  h.spawns[0].child.emit('close', -2, null);
  await settle(7);
  expect(h.spawns.length).toBe(2);
  await h.client.stop();
});

test('stop does not wait for an already-closed child', async () => {
  const h = makeHarness({ stopGraceMs: 10_000 });
  h.client.start();
  const child = h.spawns[0].child;
  child.emit('close', 1, null);
  await h.client.stop();
  expect(child.killed).toBe(false);
});

for (const outcome of ['resolve', 'reject'] as const) {
  test(`an old authentication reminder ${outcome} cannot restart a new stream generation`, async () => {
    let finish!: () => void;
    const reminder = new Promise<void>((resolve, reject) => {
      finish = outcome === 'resolve' ? resolve : () => reject(new Error('old notification failed'));
    });
    const h = makeHarness({ onAuthRequired: () => reminder });
    h.client.start();
    h.spawns[0].child.emit('close', EXIT_AUTH_REQUIRED, null);
    await h.client.stop();
    h.client.start();
    const current = h.spawns[1].child;
    finish();
    await settle(50);
    expect(h.spawns.length).toBe(2);
    current.stdout.write(JSON.stringify({ type: 'pm', data: { next_cursor: 'current-generation' } }) + '\n');
    await settle(1);
    expect(h.client.getLastCursor()).toBe('current-generation');
    expect(h.pmEvents.length).toBe(1);
    await h.client.stop();
    expect(current.killed).toBe(true);
    await settle(30);
    expect(h.spawns.length).toBe(2);
  });
}

test('late child events after stop/start cannot clear the current stream or its reader', async () => {
  const h = makeHarness();
  h.client.start();
  const old = h.spawns[0].child;
  old.kill = () => { old.killed = true; return true; };
  const stopping = h.client.stop();
  h.client.start();
  const current = h.spawns[1].child;
  old.emit('error', new Error('late old process error'));
  old.emit('exit', 1, null);
  old.emit('close', 1, null);
  await stopping;
  current.stdout.write(JSON.stringify({ type: 'pm', data: { next_cursor: 'new-cursor' } }) + '\n');
  await settle(30);
  expect(h.spawns.length).toBe(2);
  expect(h.client.getLastCursor()).toBe('new-cursor');
  expect(h.pmEvents.length).toBe(1);
  await h.client.stop();
  expect(current.killed).toBe(true);
});

test('gives up after maxConsecutiveFailures and stops running', async () => {
  const h = makeHarness({ maxConsecutiveFailures: 3 });
  h.client.start();
  for (let i = 0; i < 3; i++) {
    h.spawns[h.spawns.length - 1].child.emit('close', 1, null);
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
  h.spawns[0].child.emit('close', 1, null);
  await settle(30);
  h.spawns[1].child.emit('close', 1, null);
  await settle(30);
  h.spawns[2].child.stdout.write(JSON.stringify({ type: 'pm', data: {} }) + '\n');
  await settle(10);
  h.spawns[2].child.emit('close', 1, null);
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


test('stream children receive post-startup identity explicitly', async () => {
  const previous = process.env.EIGENFLUX_HOST;
  const child = new FakeChild();
  let observed: NodeJS.ProcessEnv | undefined;
  const h = makeHarness({spawnFn: (_bin, _args, options) => {
    observed = options.env;
    return child as unknown as ChildProcess;
  }});
  try {
    process.env.EIGENFLUX_HOST = 'claude-code';
    h.client.start();
    expect(observed?.EIGENFLUX_HOST).toBe('claude-code');
    expect(observed).not.toBe(process.env);
  } finally {
    await h.client.stop();
    if (previous === undefined) delete process.env.EIGENFLUX_HOST;
    else process.env.EIGENFLUX_HOST = previous;
  }
});
