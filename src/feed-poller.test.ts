import { expect, test } from 'bun:test';
import { FeedPoller, type ExecFn } from './feed-poller.js';
import type { CliResult } from './cli-executor.js';
import { HeartbeatPlanRunner } from './heartbeat-plan-runner.js';

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

test('real plan adapter stops before Feed for authentication failures, even when notification fails', async () => {
  for (const kind of ['auth_required', 'auth_unavailable'] as const) {
    for (const failedNotification of [false, true]) {
      let feedCalls = 0;
      let reminders = 0;
      const runner = new HeartbeatPlanRunner('eigenflux', '/stable/home', 'staging', async <T>() => (
        kind === 'auth_required' ? { kind, stderr: 'OWNER ACTION' }
          : { kind: 'error', error: new Error('credential unavailable'), exitCode: 2,
            stderr: 'UNAVAILABLE', authenticationUnavailable: true }
      ) as CliResult<T>);
      const poller = new FeedPoller({
        serverName: 'staging', eigenfluxBin: 'eigenflux', pollIntervalOverrideSec: null,
        onHeartbeatStart: () => runner.run(),
        exec: async <T>() => { feedCalls += 1; return successFeed() as CliResult<T>; },
        onFeedUpdate: async () => { throw new Error('blocked Feed must not deliver'); },
        onAuthRequired: async (detail) => {
          expect(detail).toBe('OWNER ACTION'); reminders += 1;
          if (failedNotification) throw new Error('transport unavailable');
        },
      });
      await poller.pollOnce();
      await poller.pollOnce();
      expect(feedCalls).toBe(0);
      expect(reminders).toBe(kind === 'auth_required' ? 2 : 0);
    }
  }
});

test('future hook status retains the compatible fallback and authentication errors never latch in the poller', async () => {
  let calls = 0;
  let reminders = 0;
  const poller = new FeedPoller({
    serverName: 'staging', eigenfluxBin: 'eigenflux', pollIntervalOverrideSec: null,
    onHeartbeatStart: async () => ({ kind: 'future-status' } as never),
    exec: async <T>() => { calls += 1; return { kind: 'auth_required', stderr: 'AUTH' } as CliResult<T>; },
    onFeedUpdate: async () => {},
    onAuthRequired: async () => { reminders += 1; },
  });
  await poller.pollOnce();
  await poller.pollOnce();
  expect(calls).toBe(2);
  expect(reminders).toBe(2);
});
