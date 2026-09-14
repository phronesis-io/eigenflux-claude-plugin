import { expect, test } from 'bun:test';
import { FeedPoller, type ExecFn } from './feed-poller.js';
import type { CliResult } from './cli-executor.js';

function successFeed(): CliResult<unknown> {
  return {
    kind: 'success',
    data: { items: [], notifications: [], has_more: false },
  };
}

test('runs the Heartbeat plan hook before polling Feed', async () => {
  const order: string[] = [];
  const poller = new FeedPoller({
    serverName: 'eigenflux',
    eigenfluxBin: 'eigenflux',
    pollIntervalOverrideSec: null,
    onHeartbeatStart: async () => { order.push('plan'); return null; },
    exec: (async <T>() => {
      order.push('feed');
      return successFeed() as CliResult<T>;
    }) as ExecFn,
    onFeedUpdate: async () => {},
    onAuthRequired: async () => {},
  });

  expect(await poller.pollOnce()).not.toBeNull();
  expect(order).toEqual(['plan', 'feed']);
});

test('delivers the matching central plan on empty Feed when the CLI requests a wake', async () => {
  const plan = { agent_prompt: 'CURRENT CENTRAL TASK', wake_on_empty: true };
  let feedCalls = 0;
  const deliveries: unknown[] = [];
  const poller = new FeedPoller({
    serverName: 'staging',
    eigenfluxBin: 'eigenflux',
    pollIntervalOverrideSec: null,
    onHeartbeatStart: async () => plan,
    exec: (async <T>(_bin: string, args: string[]) => {
      expect(args).toContain('staging');
      feedCalls += 1;
      return successFeed() as CliResult<T>;
    }) as ExecFn,
    onFeedUpdate: async (payload, deliveredPlan) => { deliveries.push({ payload, plan: deliveredPlan }); },
    onAuthRequired: async () => {},
  });

  const payload = await poller.pollOnce();
  expect(feedCalls).toBe(1);
  expect(deliveries).toEqual([{ payload, plan }]);
});

test('does not wake on empty Feed when the central plan declines it', async () => {
  let delivered = false;
  let successfulPolls = 0;
  const poller = new FeedPoller({
    serverName: 'eigenflux',
    eigenfluxBin: 'eigenflux',
    pollIntervalOverrideSec: null,
    onHeartbeatStart: async () => ({ agent_prompt: 'CENTRAL READ-ONLY PLAN', wake_on_empty: false }),
    exec: (async <T>() => successFeed() as CliResult<T>) as ExecFn,
    onFeedUpdate: async () => { delivered = true; },
    onPollSuccess: async () => { successfulPolls += 1; },
    onAuthRequired: async () => {},
  });

  expect(await poller.pollOnce()).not.toBeNull();
  expect(delivered).toBe(false);
  expect(successfulPolls).toBe(1);
});

test('does not reuse a prior plan after the next plan fails', async () => {
  let cycles = 0;
  const deliveredPlans: unknown[] = [];
  const poller = new FeedPoller({
    serverName: 'eigenflux',
    eigenfluxBin: 'eigenflux',
    pollIntervalOverrideSec: null,
    onHeartbeatStart: async () => {
      if (++cycles === 1) return { agent_prompt: 'FIRST PLAN', wake_on_empty: true };
      throw new Error('central plan unavailable');
    },
    exec: (async <T>() => ({
      kind: 'success',
      data: { items: [{ item_id: String(cycles) }], notifications: [], has_more: false, output_contract: 'SERVER CONTRACT' },
    }) as CliResult<T>) as ExecFn,
    onFeedUpdate: async (payload, plan) => { deliveredPlans.push({ item: payload.data.items[0].item_id, plan }); },
    onAuthRequired: async () => {},
  });

  await poller.pollOnce();
  await poller.pollOnce();
  expect(deliveredPlans).toEqual([
    { item: '1', plan: { agent_prompt: 'FIRST PLAN', wake_on_empty: true } },
    { item: '2', plan: null },
  ]);
});

test('preserves central authentication diagnostics', async () => {
  const diagnostics: string[] = [];
  const poller = new FeedPoller({
    serverName: 'eigenflux',
    eigenfluxBin: 'eigenflux',
    pollIntervalOverrideSec: null,
    exec: (async <T>() => ({ kind: 'auth_required', stderr: 'CENTRAL_AUTH_DIAGNOSTIC' }) as CliResult<T>) as ExecFn,
    onFeedUpdate: async () => { throw new Error('must not deliver failed Feed'); },
    onAuthRequired: async (detail) => { diagnostics.push(detail); },
  });

  expect(await poller.pollOnce()).toBeNull();
  expect(diagnostics).toEqual(['CENTRAL_AUTH_DIAGNOSTIC']);
});

test('continues polling Feed when the Heartbeat plan hook fails', async () => {
  let feedCalls = 0;
  const poller = new FeedPoller({
    serverName: 'eigenflux',
    eigenfluxBin: 'eigenflux',
    pollIntervalOverrideSec: null,
    onHeartbeatStart: async () => { throw new Error('plan unavailable'); },
    exec: (async <T>() => {
      feedCalls += 1;
      return successFeed() as CliResult<T>;
    }) as ExecFn,
    onFeedUpdate: async () => {},
    onAuthRequired: async () => {},
  });

  expect(await poller.pollOnce()).not.toBeNull();
  expect(feedCalls).toBe(1);
});
