#!/usr/bin/env node
/**
 * Unit tests for SettingsReporter and resolveAgentMode.
 *
 * Mirrors the sibling ClawEigenFlux settings-reporter.test.ts contract,
 * adapted to this repo's node/bun .mjs test harness (TS imported directly,
 * execEigenflux injected via config rather than module-mocked).
 *
 * Run: node tests/settings-reporter.test.mjs   (or: bun tests/settings-reporter.test.mjs)
 */

import assert from 'node:assert/strict';
import { SettingsReporter, resolveAgentMode } from '../src/settings-reporter.ts';

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// Records calls and returns a queued result; defaults to success.
function makeExec(result = { kind: 'success', data: undefined }) {
  const calls = [];
  const fn = async (bin, args) => {
    calls.push({ bin, args });
    return result;
  };
  fn.calls = calls;
  return fn;
}

// ─── resolveAgentMode ───────────────────────────────────────────────────────

console.log('\nresolveAgentMode\n');

test('maps explicit EIGENFLUX_CHANNEL=skill to skill', () => {
  assert.equal(resolveAgentMode({ EIGENFLUX_CHANNEL: 'skill' }), 'skill');
});

test('maps explicit EIGENFLUX_CHANNEL=plugin to plugin', () => {
  assert.equal(resolveAgentMode({ EIGENFLUX_CHANNEL: 'plugin' }), 'plugin');
});

test('maps claude-code host signal to plugin', () => {
  assert.equal(resolveAgentMode({ EIGENFLUX_HOST: 'claude-code/0.0.5' }), 'plugin');
});

test('maps claude-code channel to plugin', () => {
  assert.equal(resolveAgentMode({ EIGENFLUX_CHANNEL: 'claude-code' }), 'plugin');
});

test('channel takes precedence over host', () => {
  assert.equal(
    resolveAgentMode({ EIGENFLUX_CHANNEL: 'skill', EIGENFLUX_HOST: 'claude-code/1.0' }),
    'skill',
  );
});

test('returns undefined when no usable signal', () => {
  assert.equal(resolveAgentMode({}), undefined);
  assert.equal(resolveAgentMode({ EIGENFLUX_CHANNEL: 'discord' }), undefined);
});

// ─── SettingsReporter.report ─────────────────────────────────────────────────

console.log('\nSettingsReporter.report\n');

await testAsync('invokes `settings push --mode <mode>` once on a successful poll', async () => {
  const exec = makeExec();
  const reporter = new SettingsReporter({
    serverName: 'srv',
    eigenfluxBin: '/usr/bin/eigenflux',
    resolveMode: () => 'plugin',
    exec,
  });

  const ok = await reporter.report();

  assert.equal(ok, true);
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].bin, '/usr/bin/eigenflux');
  assert.deepEqual(exec.calls[0].args, ['settings', 'push', '--mode', 'plugin', '-s', 'srv']);
});

await testAsync('passes through skill mode', async () => {
  const exec = makeExec();
  const reporter = new SettingsReporter({
    serverName: 'srv',
    eigenfluxBin: 'eigenflux',
    resolveMode: () => 'skill',
    exec,
  });

  await reporter.report();
  assert.deepEqual(exec.calls[0].args, ['settings', 'push', '--mode', 'skill', '-s', 'srv']);
});

await testAsync('omits --mode when mode cannot be determined', async () => {
  const exec = makeExec();
  const reporter = new SettingsReporter({
    serverName: 'srv',
    eigenfluxBin: 'eigenflux',
    resolveMode: () => undefined,
    exec,
  });

  const ok = await reporter.report();

  assert.equal(ok, true);
  assert.deepEqual(exec.calls[0].args, ['settings', 'push', '-s', 'srv']);
});

await testAsync('default resolveMode uses env (claude-code host -> plugin)', async () => {
  const prev = { ...process.env };
  process.env.EIGENFLUX_HOST = 'claude-code/0.0.5';
  delete process.env.EIGENFLUX_CHANNEL;
  const exec = makeExec();

  try {
    const reporter = new SettingsReporter({
      serverName: 'srv',
      eigenfluxBin: 'eigenflux',
      exec,
    });
    await reporter.report();
    assert.deepEqual(exec.calls[0].args, ['settings', 'push', '--mode', 'plugin', '-s', 'srv']);
  } finally {
    process.env = prev;
  }
});

await testAsync('does not throw when CLI returns an error (best-effort)', async () => {
  const exec = makeExec({ kind: 'error', error: new Error('connection refused'), exitCode: 1, stderr: 'boom' });
  const reporter = new SettingsReporter({
    serverName: 'srv',
    eigenfluxBin: 'eigenflux',
    resolveMode: () => 'plugin',
    exec,
  });

  const ok = await reporter.report();
  assert.equal(ok, false);
});

await testAsync('does not throw when CLI returns auth_required', async () => {
  const exec = makeExec({ kind: 'auth_required', stderr: '' });
  const reporter = new SettingsReporter({
    serverName: 'srv',
    eigenfluxBin: 'eigenflux',
    resolveMode: () => 'plugin',
    exec,
  });

  assert.equal(await reporter.report(), false);
});

await testAsync('swallows a thrown exec error', async () => {
  const exec = async () => {
    throw new Error('spawn failure');
  };
  const reporter = new SettingsReporter({
    serverName: 'srv',
    eigenfluxBin: 'eigenflux',
    resolveMode: () => 'plugin',
    exec,
  });

  assert.equal(await reporter.report(), false);
});

await testAsync('skips concurrent report while one is in flight (no duplicate spawn)', async () => {
  let resolveExec;
  let callCount = 0;
  const exec = async () => {
    callCount++;
    return new Promise((res) => {
      resolveExec = res;
    });
  };

  const reporter = new SettingsReporter({
    serverName: 'srv',
    eigenfluxBin: 'eigenflux',
    resolveMode: () => 'plugin',
    exec,
  });

  const first = reporter.report();
  const second = await reporter.report(); // in-flight → skipped
  assert.equal(second, false);
  assert.equal(callCount, 1);

  resolveExec({ kind: 'success', data: undefined });
  assert.equal(await first, true);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
