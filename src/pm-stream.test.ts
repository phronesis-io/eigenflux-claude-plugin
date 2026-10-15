import { test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('CLI version handoff drains notifications, then exits, then resumes the fixed identity and cursor', async () => {
  const delivered = deferred();
  const h = makeHarness({ eigenfluxHome: '/fixed/agent/.eigenflux', onPmEvent: () => delivered.promise });
  h.client.start();
  const old = h.spawns[0].child;
  old.stdout.write(JSON.stringify({ type: 'pm', data: { next_cursor: 'delivered-42' } }) + '\n');
  await settle(1);
  const handoff = h.client.refreshForCliVersion('0.6.6');
  await settle(1);
  expect(old.killed).toBe(false);
  expect(h.client.getLastCursor()).toBeNull();
  expect(h.spawns.length).toBe(1);
  delivered.resolve();
  await handoff;
  expect(old.killed).toBe(true);
  expect(h.spawns.length).toBe(2);
  expect(h.spawns[1].args).toEqual([
    'stream', '-s', 'srv', '-f', 'json', '--homedir', '/fixed/agent/.eigenflux', '--cursor', 'delivered-42',
  ]);
  await h.client.refreshForCliVersion('0.6.6');
  expect(h.spawns.length).toBe(2);
  await h.client.refreshForCliVersion('0.6.7');
  expect(h.spawns.length).toBe(3);
  await h.client.stop();
});

test('failed notification pins the replay cursor across CLI handoff', async () => {
  let deliveries = 0;
  const h = makeHarness({ async onPmEvent() {
    if (++deliveries === 2) throw new Error('transport unavailable');
  }});
  h.client.start();
  for (const next_cursor of ['committed', 'failed', 'later']) {
    h.spawns[0].child.stdout.write(JSON.stringify({ type: 'pm', data: { next_cursor } }) + '\n');
  }
  await h.client.refreshForCliVersion('0.6.6');
  expect(h.client.getLastCursor()).toBe('committed');
  expect(h.spawns[1].args.slice(-2)).toEqual(['--cursor', 'committed']);
  await h.client.stop();
});

test('notification timeout defers handoff without killing or overlapping the old process', async () => {
  const delivered = deferred();
  const h = makeHarness({ notificationGraceMs: 5, onPmEvent: () => delivered.promise });
  h.client.start();
  h.spawns[0].child.stdout.write(JSON.stringify({ type: 'pm', data: { next_cursor: 'pending' } }) + '\n');
  await expect(h.client.refreshForCliVersion('0.6.6')).rejects.toThrow('drain timed out');
  expect(h.spawns[0].child.killed).toBe(false);
  expect(h.spawns.length).toBe(1);
  delivered.resolve();
  await h.client.refreshForCliVersion('0.6.6');
  expect(h.spawns.length).toBe(2);
  await h.client.stop();
});

test('unconfirmed child exit blocks replacement even after SIGKILL', async () => {
  const signals: string[] = [];
  const h = makeHarness({ stopGraceMs: 5 });
  h.client.start();
  const old = h.spawns[0].child;
  old.kill = (signal) => { signals.push(signal ?? 'SIGTERM'); return true; };
  await expect(h.client.refreshForCliVersion('0.6.6')).rejects.toThrow('has not exited');
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(h.spawns.length).toBe(1);
  h.client.start();
  expect(h.spawns.length).toBe(1);
  old.emit('exit', null, 'SIGKILL');
  await h.client.stop();
});

test('stop during CLI handoff drains delivery and prevents a replacement process', async () => {
  const delivered = deferred();
  const h = makeHarness({ onPmEvent: () => delivered.promise });
  h.client.start();
  h.spawns[0].child.stdout.write(JSON.stringify({ type: 'pm', data: { next_cursor: 'pending' } }) + '\n');
  const handoff = h.client.refreshForCliVersion('0.6.6');
  const stop = h.client.stop();
  delivered.resolve();
  await Promise.all([handoff, stop]);
  expect(h.spawns.length).toBe(1);
  expect(h.spawns[0].child.killed).toBe(true);
  expect(h.client.isRunning()).toBe(false);
});


test('real child replacement starts only after the old PID exits', async () => {
  const children: ChildProcess[] = [];
  const firstDelivered = deferred();
  const client = new PmStreamClient({
    serverName: 'fixed', eigenfluxBin: '/test/eigenflux', eigenfluxHome: '/fixed/home',
    async onAuthRequired() {},
    async onPmEvent() { firstDelivered.resolve(); },
    spawnFn: (_bin, _args, options) => {
      const previous = children.at(-1);
      if (previous?.pid) {
        expect(() => process.kill(previous.pid!, 0)).toThrow();
      }
      const script = `
        process.stdout.write(JSON.stringify({type:'pm',data:{next_cursor:'real-cursor'}})+'\\n');
        setInterval(() => {}, 1000);
      `;
      const child = spawn(process.execPath, ['-e', script], options);
      children.push(child);
      return child;
    },
  });
  try {
    client.start();
    await firstDelivered.promise;
    await client.refreshForCliVersion('0.6.6');
    expect(children.length).toBe(2);
    expect(client.getLastCursor()).toBe('real-cursor');
  } finally {
    await client.stop();
  }
});


test('SIGKILL handoff still waits for confirmed exit before replacement', async () => {
  const h = makeHarness({ stopGraceMs: 5 });
  const signals: string[] = [];
  h.client.start();
  const old = h.spawns[0].child;
  old.kill = (signal) => {
    signals.push(signal ?? 'SIGTERM');
    if (signal === 'SIGKILL') setImmediate(() => old.emit('exit', null, signal));
    return true;
  };
  await h.client.refreshForCliVersion('0.6.6');
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(h.spawns.length).toBe(2);
  await h.client.stop();
});
