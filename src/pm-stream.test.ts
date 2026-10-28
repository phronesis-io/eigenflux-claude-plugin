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
  finish(code: number | null, signal: string | null): void {
    this.emit('exit', code, signal);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, signal));
  }
  kill(_signal?: string): boolean {
    this.killed = true;
    // Simulate the process dying promptly on SIGTERM.
    setImmediate(() => this.finish(null, 'SIGTERM'));
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

  h.spawns[0].child.finish(1, null);
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
  h.spawns[0].child.finish(EXIT_AUTH_REQUIRED, null);
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
  expect(h.spawns.length).toBe(1); // Never overlap an unconfirmed old process.
  old.emit('exit', 1, null);
  old.emit('close', 1, null);
  await stopping;
  h.client.start();
  const current = h.spawns[1].child;
  old.emit('error', new Error('late old process error'));
  old.emit('exit', 1, null);
  old.emit('close', 1, null);
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
    h.spawns[h.spawns.length - 1].child.finish(1, null);
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
  h.spawns[0].child.finish(1, null);
  await settle(30);
  h.spawns[1].child.finish(1, null);
  await settle(30);
  h.spawns[2].child.stdout.write(JSON.stringify({ type: 'pm', data: {} }) + '\n');
  await settle(10);
  h.spawns[2].child.finish(1, null);
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

test('CLI version handoff closes old stdio, drains notifications, and resumes the fixed identity and cursor', async () => {
  const delivered = deferred();
  const h = makeHarness({ eigenfluxHome: '/fixed/agent/.eigenflux', onPmEvent: () => delivered.promise });
  h.client.start();
  const old = h.spawns[0].child;
  old.stdout.write(JSON.stringify({ type: 'pm', data: { next_cursor: 'delivered-42' } }) + '\n');
  await settle(1);
  const handoff = h.client.refreshForCliVersion('0.6.6');
  await settle(1);
  expect(old.killed).toBe(true);
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

test('failed notifications remain local and must be delivered before CLI replacement', async () => {
  let fail = true;
  const attempted: string[] = [];
  const h = makeHarness({ async onPmEvent(event) {
    attempted.push(event.data.next_cursor!);
    if (event.data.next_cursor === 'failed' && fail) throw new Error('transport unavailable');
  }});
  h.client.start();
  for (const next_cursor of ['committed', 'failed', 'later']) {
    h.spawns[0].child.stdout.write(JSON.stringify({ type: 'pm', data: { next_cursor } }) + '\n');
  }
  await expect(h.client.refreshForCliVersion('0.6.6')).rejects.toThrow('remain pending');
  expect(h.client.getLastCursor()).toBe('committed');
  expect(h.spawns.length).toBe(1);
  expect(attempted).not.toContain('later');
  fail = false;
  await h.client.refreshForCliVersion('0.6.6');
  expect(attempted.slice(-2)).toEqual(['failed', 'later']);
  expect(h.client.getLastCursor()).toBe('later');
  expect(h.spawns.length).toBe(2);
  await h.client.stop();
});

test('notification timeout retains the local pending delivery and blocks replacement', async () => {
  const delivered = deferred();
  const h = makeHarness({ notificationGraceMs: 5, onPmEvent: () => delivered.promise });
  h.client.start();
  h.spawns[0].child.stdout.write(JSON.stringify({ type: 'pm', data: { next_cursor: 'pending' } }) + '\n');
  await expect(h.client.refreshForCliVersion('0.6.6')).rejects.toThrow('drain timed out');
  expect(h.spawns[0].child.killed).toBe(true);
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
  await expect(h.client.refreshForCliVersion('0.6.6')).rejects.toThrow('stdio has not closed');
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(h.spawns.length).toBe(1);
  h.client.start();
  expect(h.spawns.length).toBe(1);
  old.finish(null, 'SIGKILL');
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
    if (signal === 'SIGKILL') setImmediate(() => old.finish(null, signal));
    return true;
  };
  await h.client.refreshForCliVersion('0.6.6');
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(h.spawns.length).toBe(2);
  await h.client.stop();
});

test('handoff keeps reading tail messages after exit and drains through stdio close', async () => {
  const gate = deferred();
  const got: string[] = [];
  const h = makeHarness({ async onPmEvent(event) {
    got.push(event.data.next_cursor!);
    if (event.data.next_cursor === '100') await gate.promise;
  }});
  h.client.start();
  const old = h.spawns[0].child;
  old.kill = () => { old.killed = true; old.emit('exit', 0, null); return true; };
  old.stdout.write(JSON.stringify({ type: 'pm', data: { next_cursor: '100' } }) + '\n');
  const handoff = h.client.refreshForCliVersion('0.6.6');
  // An unterminated final line is flushed only when stdout ends.
  old.stdout.end(JSON.stringify({ type: 'pm', data: { next_cursor: '101' } }));
  old.stderr.end();
  await settle(1);
  expect(h.spawns.length).toBe(1);
  expect(got).toEqual(['100']);
  old.emit('close', 0, null);
  await settle(1);
  expect(h.spawns.length).toBe(1);
  gate.resolve();
  await handoff;
  expect(got).toEqual(['100', '101']);
  expect(h.spawns[1].args.slice(-2)).toEqual(['--cursor', '101']);
  await h.client.stop();
});

test('real inherited stdout tail is delivered after process exit before CLI replacement', async () => {
  const got: string[] = [];
  const first = deferred();
  const children: ChildProcess[] = [];
  let exitSeen = false;
  let closeSeen = false;
  const client = new PmStreamClient({
    serverName: 'fixed', eigenfluxBin: '/test/eigenflux',
    async onAuthRequired() {},
    async onPmEvent(event) {
      got.push(event.data.next_cursor!);
      if (event.data.next_cursor === '100') first.resolve();
      if (event.data.next_cursor === '101') expect(exitSeen).toBe(true);
    },
    spawnFn: (_bin, _args, options) => {
      if (children.length) {
        expect(closeSeen).toBe(true);
        expect(got).toEqual(['100', '101']);
      }
      const tail = JSON.stringify({ type: 'pm', data: { next_cursor: '101' } }) + '\n';
      const tailProgram = `setTimeout(() => process.stdout.write(${JSON.stringify(tail)}), 60)`;
      const script = `
        const { spawn } = require('child_process');
        process.on('SIGTERM', () => {
          spawn(process.execPath, ['-e', ${JSON.stringify(tailProgram)}], {stdio:['ignore',1,2]}).unref();
          process.exit(0);
        });
        process.stdout.write(JSON.stringify({type:'pm',data:{next_cursor:'100'}})+'\\n');
        setInterval(() => {}, 1000);
      `;
      const child = spawn(process.execPath, ['-e', script], options);
      if (!children.length) {
        child.once('exit', () => { exitSeen = true; });
        child.once('close', () => { closeSeen = true; });
      }
      children.push(child);
      return child;
    },
  });
  try {
    client.start();
    await first.promise;
    await client.refreshForCliVersion('0.6.6');
    expect(children.length).toBe(2);
    expect(got).toEqual(['100', '101']);
  } finally {
    await client.stop();
  }
});

test('exit without stdio close blocks replacement and never signals an exited PID again', async () => {
  const h = makeHarness({ stopGraceMs: 5 });
  const signals: string[] = [];
  h.client.start();
  const old = h.spawns[0].child;
  old.kill = (signal) => {
    signals.push(signal ?? 'SIGTERM');
    old.emit('exit', 0, null);
    return true;
  };
  await expect(h.client.refreshForCliVersion('0.6.6')).rejects.toThrow('stdio has not closed');
  expect(signals).toEqual(['SIGTERM']);
  expect(h.spawns.length).toBe(1);
  old.stdout.end(JSON.stringify({ type: 'pm', data: { next_cursor: 'tail' } }) + '\n');
  old.stderr.end();
  await settle(1);
  old.emit('close', 0, null);
  await h.client.refreshForCliVersion('0.6.6');
  expect(h.client.getLastCursor()).toBe('tail');
  expect(h.spawns.length).toBe(2);
  await h.client.stop();
});

test('unchanged CLI version retries the actual local failed notification', async () => {
  let fail = false;
  let delivered = 0;
  const h = makeHarness({ async onPmEvent() {
    if (fail) throw new Error('transport unavailable');
    delivered += 1;
  }});
  h.client.start();
  await h.client.refreshForCliVersion('0.6.6');
  fail = true;
  h.spawns[1].child.stdout.write(JSON.stringify({ type: 'pm', data: { next_cursor: 'pending' } }) + '\n');
  await settle(1);
  expect(delivered).toBe(0);
  fail = false;
  await h.client.refreshForCliVersion('0.6.6');
  expect(delivered).toBe(1);
  expect(h.client.getLastCursor()).toBe('pending');
  expect(h.spawns.length).toBe(2);
  await h.client.stop();
});
