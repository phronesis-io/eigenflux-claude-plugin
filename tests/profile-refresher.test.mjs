#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { ProfileRefresher } from '../src/profile-refresher.ts';

let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function refresher(options = {}) {
  return new ProfileRefresher({
    serverName: 'staging',
    eigenfluxBin: '/mock/eigenflux',
    collectContext: () => ({ memoryDirs: ['/mock/memory'], sessionSnippets: ['mock host context'] }),
    onRefreshPrompt: async () => {},
    onAuthRequired: async () => {},
    exec: async () => ({ kind: 'success', data: '' }),
    ...options,
  });
}

await test('passes host context to the central task and delivers its prompt once', async () => {
  const calls = [];
  const delivered = [];
  const adapter = refresher({
    exec: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { kind: 'success', data: 'CENTRAL PROFILE TASK' };
    },
    onRefreshPrompt: async (prompt) => { delivered.push(prompt); },
  });
  adapter.start();
  assert.equal(calls.length, 0, 'start must not schedule a separate business timer');
  await adapter.refresh();
  adapter.stop();
  assert.deepEqual(delivered, ['CENTRAL PROFILE TASK']);
  assert.deepEqual(calls, [{
    bin: '/mock/eigenflux',
    args: ['profile', 'refresh-task', '-s', 'staging', '--format', 'agent', '--memory-dir', '/mock/memory', '--session-snippet', 'mock host context'],
    options: { parseJson: false },
  }]);
});

await test('central empty results stay silent and later heartbeats can become due', async () => {
  let calls = 0;
  const delivered = [];
  const adapter = refresher({
    exec: async () => ({ kind: 'success', data: ++calls === 1 ? '' : 'NOW DUE' }),
    onRefreshPrompt: async (prompt) => { delivered.push(prompt); },
  });
  adapter.start();
  await adapter.refresh();
  assert.deepEqual(delivered, []);
  await adapter.refresh();
  adapter.stop();
  assert.deepEqual(delivered, ['NOW DUE']);
  assert.equal(calls, 2);
});

await test('leaves empty-context decisions to the CLI', async () => {
  let args;
  const adapter = refresher({
    collectContext: () => ({ memoryDirs: [], sessionSnippets: [] }),
    exec: async (_bin, actualArgs) => { args = actualArgs; return { kind: 'success', data: '' }; },
  });
  adapter.start();
  await adapter.refresh();
  adapter.stop();
  assert.deepEqual(args, ['profile', 'refresh-task', '-s', 'staging', '--format', 'agent']);
});

await test('preserves auth diagnostics without delivering a fabricated task', async () => {
  const diagnostics = [];
  const adapter = refresher({
    exec: async () => ({ kind: 'auth_required', stderr: 'CENTRAL AUTH DETAIL' }),
    onAuthRequired: async (detail) => { diagnostics.push(detail); },
    onRefreshPrompt: async () => { throw new Error('failed CLI result must not become a task'); },
  });
  adapter.start();
  await adapter.refresh();
  adapter.stop();
  assert.deepEqual(diagnostics, ['CENTRAL AUTH DETAIL']);
});

await test('deduplicates in-flight work and suppresses delivery after stop', async () => {
  let finish;
  let calls = 0;
  let deliveries = 0;
  const adapter = refresher({
    exec: async () => {
      calls += 1;
      return new Promise((resolve) => { finish = resolve; });
    },
    onRefreshPrompt: async () => { deliveries += 1; },
  });
  adapter.start();
  const pending = adapter.refresh();
  await adapter.refresh();
  assert.equal(calls, 1);
  adapter.stop();
  finish({ kind: 'success', data: 'LATE TASK' });
  await pending;
  assert.equal(deliveries, 0);
});

console.log(`${passed} profile adapter tests passed`);
