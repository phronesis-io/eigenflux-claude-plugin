import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { WatchClient, type WatchEvent } from './watch-client.js';

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 123;
  signals: string[] = [];
  autoExit = true;
  kill(signal: string) {
    this.signals.push(signal);
    if (this.autoExit) setImmediate(() => this.emit('exit', 0, signal));
    return true;
  }
  send(type: string, data: Record<string, unknown> = {}, id = type, scope = 'opaque-account-hash') {
    this.stdout.write(JSON.stringify({ schema_version: 'eigenflux_watch.v1', type, state_scope: scope, event_id: id, data }) + '\n');
  }
  started(version = '1.0.0', agent = 'agent-one') {
    this.send('started', { cli_version: version, home: '/tmp/watch-home', server: 'test', agent_id: agent });
  }
}
function harness() {
  const children: Child[] = [];
  const args: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const events: WatchEvent[] = [];
  const diagnostics: string[] = [];
  const client = new WatchClient({
    eigenfluxBin: 'eigenflux', eigenfluxHome: '/tmp/watch-home', serverName: 'test', retryMs: 5, stopGraceMs: 15,
    spawnFn: (_bin, argv, options) => {
      const child = new Child(); children.push(child); args.push(argv); envs.push(options.env);
      return child as unknown as ChildProcess;
    },
    async onEvent(event) { events.push(event); },
    async onDiagnostic(detail) { diagnostics.push(detail); },
  });
  return { client, children, args, envs, events, diagnostics };
}

test('watch pins Home/server, clears inherited reexec, and preserves legacy PM payload', async () => {
  const previous = process.env.EIGENFLUX_UPDATE_REEXEC;
  process.env.EIGENFLUX_UPDATE_REEXEC = 'old-update';
  const h = harness();
  try {
    h.client.start();
    expect(h.args[0]).toEqual(['--homedir', '/tmp/watch-home', '--server', 'test', 'watch']);
    expect(h.envs[0].EIGENFLUX_UPDATE_REEXEC).toBeUndefined();
    const child = h.children[0];
    child.send('pm_push', { messages: ['before-started'] });
    child.started();
    child.send('pm_push', { messages: [{ msg_id: 'm', content: 'hello' }] }, 'pm-1');
    child.send('pm_push', { messages: [{ msg_id: 'm', content: 'hello' }] }, 'pm-1');
    child.send('friend_accepted', { agent_id: 'friend' }, 'friend-1');
    await settle();
    expect(h.events.map((event) => event.type)).toEqual(['pm_push', 'friend_accepted']);
    expect(h.events[0].data.messages).toEqual([{ msg_id: 'm', content: 'hello' }]);
  } finally {
    await h.client.stop();
    if (previous === undefined) delete process.env.EIGENFLUX_UPDATE_REEXEC;
    else process.env.EIGENFLUX_UPDATE_REEXEC = previous;
  }
});

test('replacement waits for confirmed exit and does not replay events', async () => {
  const h = harness(); h.client.start();
  const old = h.children[0]; old.autoExit = false; old.started();
  old.send('pm_push', {}, 'once');
  old.send('restart_required', { cli_version: '1.0.1' });
  await settle(5);
  expect(h.children).toHaveLength(1);
  expect(old.signals).toEqual(['SIGTERM']);
  old.emit('exit', 0, 'SIGTERM');
  await settle();
  expect(h.children).toHaveLength(2);
  h.children[1].started('1.0.1');
  h.children[1].send('runtime_ready', { cli_version: '1.0.1', home: '/tmp/watch-home', server: 'test', agent_id: 'agent-one' });
  h.children[1].send('pm_push', {}, 'once');
  await settle();
  expect(h.events).toHaveLength(1);
  expect(h.diagnostics).toHaveLength(0);
  await h.client.stop();
});

test('missing exit confirmation blocks replacement after bounded TERM/KILL', async () => {
  const h = harness(); h.client.start();
  const child = h.children[0]; child.autoExit = false; child.started();
  child.send('restart_required', { cli_version: '1.0.1' });
  await settle(55);
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(h.children).toHaveLength(1);
  expect(h.client.isRunning()).toBe(false);
  expect(h.diagnostics.some((detail) => detail.includes('exit could not be confirmed'))).toBe(true);
  child.emit('exit', 0, 'SIGKILL');
  await h.client.stop();
});

test('fault restart validates account identity and stops instead of following a new Agent', async () => {
  const h = harness(); h.client.start(); h.children[0].started();
  h.children[0].emit('exit', 1, null);
  await settle(15);
  expect(h.children).toHaveLength(2);
  h.children[1].started('1.0.0', 'different-agent');
  await settle();
  expect(h.client.isRunning()).toBe(false);
  expect(h.diagnostics.some((detail) => detail.includes('identity or configuration changed'))).toBe(true);
  await h.client.stop();
});

test('runtime_ready mismatch is rejected and identity_changed diagnostics stop consumption', async () => {
  for (const type of ['runtime_ready', 'diagnostic']) {
    const h = harness(); h.client.start(); h.children[0].started();
    h.children[0].send(type, type === 'diagnostic' ? { code: 'identity_changed' } : { cli_version: '1.0.0', home: '/tmp/other', server: 'test', agent_id: 'agent-one' });
    await settle();
    expect(h.client.isRunning()).toBe(false);
    expect(h.events).toHaveLength(0);
    await h.client.stop();
  }
});

test('stop during replacement never starts a replacement', async () => {
  const h = harness(); h.client.start(); h.children[0].started(); h.children[0].autoExit = false;
  h.children[0].send('restart_required', { cli_version: '1.0.1' });
  const stopped = h.client.stop();
  h.children[0].emit('exit', 0, 'SIGTERM');
  await stopped; await settle();
  expect(h.children).toHaveLength(1);
});


test('all fatal diagnostics and exit 78 stop the account callback without retrying', async () => {
  for (const code of ['identity_changed', 'configuration_changed', 'owner_replaced', 'exit78']) {
    let fatal = 0;
    const child = new Child();
    const client = new WatchClient({
      eigenfluxBin: 'ef', eigenfluxHome: '/tmp/watch-home', serverName: 'test', retryMs: 1,
      spawnFn: () => child as unknown as ChildProcess,
      async onEvent() {}, async onDiagnostic() {}, async onFatal() { fatal++; },
    });
    client.start(); child.started();
    if (code === 'exit78') child.emit('exit', 78); else child.send('diagnostic', { code });
    await settle();
    expect(client.isRunning()).toBe(false);
    expect(fatal).toBe(1);
    await client.stop();
  }
});
