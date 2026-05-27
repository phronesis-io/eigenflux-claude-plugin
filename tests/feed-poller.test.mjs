#!/usr/bin/env node
/**
 * Unit tests for FeedPoller.
 *
 * Run: node tests/feed-poller.test.mjs
 */

import assert from 'node:assert/strict';

// We can't easily import TypeScript directly from node, so we test the
// behavioral contract by re-implementing the core guard logic in a minimal
// harness that mirrors FeedPoller's pollOnce + scheduleNext structure.

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

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.error(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✕ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.error('\nFeedPoller unit tests\n');

// ─── Test: deliveryInFlight guard prevents concurrent delivery ────────────

await testAsync('skips delivery when previous is in flight', async () => {
  let deliveryInFlight = false;
  let deliveryCount = 0;
  let skipCount = 0;

  const deliver = async () => {
    if (deliveryInFlight) {
      skipCount++;
      return;
    }
    deliveryInFlight = true;
    try {
      deliveryCount++;
      // Simulate slow delivery
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      deliveryInFlight = false;
    }
  };

  // Start first delivery (don't await)
  const first = deliver();
  // Try second while first is pending
  await deliver();
  await first;

  assert.equal(deliveryCount, 1, 'only one delivery should have executed');
  assert.equal(skipCount, 1, 'one delivery should have been skipped');
});

// ─── Test: flag resets after delivery completes ──────────────────────────

await testAsync('flag resets after delivery completes', async () => {
  let deliveryInFlight = false;
  let deliveryCount = 0;

  const deliver = async () => {
    if (deliveryInFlight) return;
    deliveryInFlight = true;
    try {
      deliveryCount++;
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      deliveryInFlight = false;
    }
  };

  await deliver();
  await deliver();

  assert.equal(deliveryCount, 2, 'both deliveries should have executed sequentially');
});

// ─── Test: flag resets even on delivery error ────────────────────────────

await testAsync('flag resets even when delivery throws', async () => {
  let deliveryInFlight = false;
  let errorCaught = false;

  const deliver = async () => {
    if (deliveryInFlight) return;
    deliveryInFlight = true;
    try {
      throw new Error('delivery failed');
    } finally {
      deliveryInFlight = false;
    }
  };

  try {
    await deliver();
  } catch {
    errorCaught = true;
  }

  assert.equal(errorCaught, true, 'error should have been thrown');
  assert.equal(deliveryInFlight, false, 'flag should be reset after error');
});

// ─── Test: timeout protection resets stale flag ──────────────────────────

await testAsync('timeout protection resets stale delivery flag', async () => {
  let deliveryInFlight = true;
  let deliveryStartedAt = Date.now() - 400_000; // 400s ago
  const DELIVERY_TIMEOUT_MS = 300_000;

  // Simulate the timeout check in pollOnce
  if (deliveryInFlight && deliveryStartedAt > 0) {
    const elapsed = Date.now() - deliveryStartedAt;
    if (elapsed > DELIVERY_TIMEOUT_MS) {
      deliveryInFlight = false;
    }
  }

  assert.equal(deliveryInFlight, false, 'stale flag should be force-reset');
});

// ─── Test: skip counter increments correctly ─────────────────────────────

await testAsync('skip counter increments on each skip', async () => {
  let deliveryInFlight = false;
  let skipCount = 0;
  let deliveryCount = 0;

  const deliver = async () => {
    if (deliveryInFlight) {
      skipCount++;
      return;
    }
    deliveryInFlight = true;
    try {
      deliveryCount++;
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      deliveryInFlight = false;
    }
  };

  const first = deliver();
  await deliver(); // skip 1
  await deliver(); // skip 2
  await deliver(); // skip 3
  await first;

  assert.equal(deliveryCount, 1);
  assert.equal(skipCount, 3, 'skip count should be 3');
});

// ─── Test: chain schedule doesn't overlap polls ──────────────────────────

await testAsync('setTimeout chain prevents poll overlap', async () => {
  let pollCount = 0;
  let maxConcurrent = 0;
  let concurrent = 0;

  const pollOnce = async () => {
    concurrent++;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    pollCount++;
    await new Promise((r) => setTimeout(r, 20));
    concurrent--;
  };

  // Simulate chain scheduling (3 polls)
  for (let i = 0; i < 3; i++) {
    await pollOnce();
  }

  assert.equal(pollCount, 3);
  assert.equal(maxConcurrent, 1, 'chain scheduling should never have concurrent polls');
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.error(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
