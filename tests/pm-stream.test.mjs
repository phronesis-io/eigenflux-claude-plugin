#!/usr/bin/env node
/**
 * Unit tests for PmStreamClient's behavioral contract.
 *
 * Run: node tests/pm-stream.test.mjs
 *
 * Mirrors the style of feed-poller.test.mjs: the reconnect/backoff/cursor
 * state machine is exercised via a minimal harness that re-implements the
 * exact constants and transitions of src/pm-stream.ts.
 */

import assert from 'node:assert/strict';

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;
const MAX_CONSECUTIVE_FAILURES = 20;
const EXIT_AUTH_REQUIRED = 4;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.error(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✕ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// Minimal harness mirroring PmStreamClient's state transitions.
function makeStream() {
  const state = {
    running: true,
    stopping: false,
    lastCursor: null,
    backoffMs: INITIAL_BACKOFF_MS,
    consecutiveFailures: 0,
    authCalls: 0,
    restartDelays: [],
  };

  return {
    state,
    // Mirrors handleLine: parse, update cursor, reset backoff.
    handleLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return null;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return null; // parse errors do NOT touch backoff/cursor
      }
      if (event.data?.next_cursor) state.lastCursor = event.data.next_cursor;
      state.backoffMs = INITIAL_BACKOFF_MS;
      state.consecutiveFailures = 0;
      return event;
    },
    // Mirrors the child 'exit' handler.
    handleExit(code) {
      if (state.stopping) return;
      if (code === EXIT_AUTH_REQUIRED) {
        state.authCalls += 1;
      }
      this.scheduleRestart();
    },
    // Mirrors scheduleRestart.
    scheduleRestart() {
      if (state.stopping || !state.running) return;
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        state.running = false;
        return;
      }
      state.restartDelays.push(state.backoffMs);
      state.backoffMs = Math.min(state.backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
    },
    // Mirrors spawn args assembly.
    spawnArgs(serverName) {
      const args = ['stream', '-s', serverName, '-f', 'json'];
      if (state.lastCursor) args.push('--cursor', state.lastCursor);
      return args;
    },
  };
}

console.error('\nPmStreamClient unit tests\n');

// ─── Backoff progression ───────────────────────────────────────────────────

test('backoff doubles per failure and caps at 60s', () => {
  const s = makeStream();
  for (let i = 0; i < 10; i++) s.scheduleRestart();
  assert.deepEqual(
    s.state.restartDelays.slice(0, 7),
    [1000, 2000, 4000, 8000, 16000, 32000, 60000],
  );
  // Every delay after reaching the cap stays at the cap.
  for (const d of s.state.restartDelays.slice(6)) assert.equal(d, 60000);
});

test('gives up after 20 consecutive failures', () => {
  const s = makeStream();
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
    assert.equal(s.state.running, true, `still running before failure #${i + 1}`);
    s.scheduleRestart();
  }
  assert.equal(s.state.running, false, 'stopped after failure cap');
  // 20th failure stops the client instead of arming another restart.
  assert.equal(s.state.restartDelays.length, MAX_CONSECUTIVE_FAILURES - 1);
});

test('a successful message resets backoff and failure count', () => {
  const s = makeStream();
  for (let i = 0; i < 5; i++) s.scheduleRestart();
  assert.equal(s.state.backoffMs > INITIAL_BACKOFF_MS, true);

  s.handleLine(JSON.stringify({ type: 'pm', data: { messages: [] } }));
  assert.equal(s.state.backoffMs, INITIAL_BACKOFF_MS);
  assert.equal(s.state.consecutiveFailures, 0);

  // The next failure starts from the initial backoff again.
  s.scheduleRestart();
  assert.equal(s.state.restartDelays.at(-1), INITIAL_BACKOFF_MS);
});

// ─── Cursor resume ─────────────────────────────────────────────────────────

test('next_cursor is captured and passed on reconnect via --cursor', () => {
  const s = makeStream();
  assert.deepEqual(s.spawnArgs('srv'), ['stream', '-s', 'srv', '-f', 'json']);

  s.handleLine(JSON.stringify({ type: 'pm', data: { messages: [], next_cursor: 'c-42' } }));
  assert.equal(s.state.lastCursor, 'c-42');
  assert.deepEqual(s.spawnArgs('srv'), ['stream', '-s', 'srv', '-f', 'json', '--cursor', 'c-42']);
});

test('events without next_cursor keep the previous cursor', () => {
  const s = makeStream();
  s.handleLine(JSON.stringify({ type: 'pm', data: { next_cursor: 'c-1' } }));
  s.handleLine(JSON.stringify({ type: 'pm', data: { messages: [] } }));
  assert.equal(s.state.lastCursor, 'c-1');
});

// ─── Line parsing ──────────────────────────────────────────────────────────

test('malformed lines are skipped without touching backoff state', () => {
  const s = makeStream();
  for (let i = 0; i < 3; i++) s.scheduleRestart();
  const backoffBefore = s.state.backoffMs;

  assert.equal(s.handleLine('not-json{{{'), null);
  assert.equal(s.handleLine('   '), null);
  assert.equal(s.state.backoffMs, backoffBefore, 'backoff unchanged by bad lines');
  assert.equal(s.state.lastCursor, null);
});

// ─── Exit handling ─────────────────────────────────────────────────────────

test('exit code 4 triggers the auth handler and still schedules a restart', () => {
  const s = makeStream();
  s.handleExit(EXIT_AUTH_REQUIRED);
  assert.equal(s.state.authCalls, 1);
  assert.equal(s.state.restartDelays.length, 1, 'restart armed after auth exit');
});

test('non-auth exits restart without the auth handler', () => {
  const s = makeStream();
  s.handleExit(1);
  assert.equal(s.state.authCalls, 0);
  assert.equal(s.state.restartDelays.length, 1);
});

test('exits during stop are ignored entirely', () => {
  const s = makeStream();
  s.state.stopping = true;
  s.handleExit(1);
  s.handleExit(EXIT_AUTH_REQUIRED);
  assert.equal(s.state.authCalls, 0);
  assert.equal(s.state.restartDelays.length, 0);
});

// ─── Summary ───────────────────────────────────────────────────────────────

console.error(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
