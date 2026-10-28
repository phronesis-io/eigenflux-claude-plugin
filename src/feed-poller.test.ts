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
    onHeartbeatStart: async () => { order.push('plan'); return {agent_prompt:'plan',wake_on_empty:false}; },
    exec: (async <T>() => {
      order.push('feed');
      return successFeed() as CliResult<T>;
    }) as ExecFn,
    onFeedUpdate: async () => {},
    onAuthRequired: async () => {},
  });

  expect(await poller.pollOnce()).not.toBeNull();
  expect(order).toEqual(['plan', 'feed', 'feed']);
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
      if (args[0] === 'version') return {kind:'success',data:{cli_version:'0.6.10'}} as CliResult<T>;
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
  ]);
});

test('preserves central authentication diagnostics', async () => {
  const diagnostics: string[] = [];
  const poller = new FeedPoller({
    serverName: 'eigenflux',
    eigenfluxBin: 'eigenflux',
    pollIntervalOverrideSec: null,
    onHeartbeatStart:async()=>({agent_prompt:'plan',wake_on_empty:false}),
    exec: (async <T>() => ({ kind: 'auth_required', stderr: 'CENTRAL_AUTH_DIAGNOSTIC' }) as CliResult<T>) as ExecFn,
    onFeedUpdate: async () => { throw new Error('must not deliver failed Feed'); },
    onAuthRequired: async (detail) => { diagnostics.push(detail); },
  });

  expect(await poller.pollOnce()).toBeNull();
  expect(diagnostics).toEqual(['CENTRAL_AUTH_DIAGNOSTIC']);
});

test('skips Feed when the Heartbeat plan hook fails', async () => {
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

  expect(await poller.pollOnce()).toBeNull();
  expect(feedCalls).toBe(0);
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

test('unknown plan status never permits a Feed poll', async () => {
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
  expect(calls).toBe(0);
  expect(reminders).toBe(0);
});

test('capacity and failed sends retain the original payload and retry once', async()=>{
 let feedCalls=0,attempts=0,maintenance=0;const seen:unknown[]=[];
 let finish!:()=>void;
 const poller=new FeedPoller({serverName:'test',eigenfluxBin:'eigenflux',pollIntervalOverrideSec:60,
 onHeartbeatStart:async()=>({agent_prompt:'original',wake_on_empty:true}),
 exec:async<T>(_bin:string,args:string[])=>({kind:'success',data:args[0]==='version'?{cli_version:'0.7.0'}:{items:[{item_id:String(++feedCalls)}],notifications:[]}} as CliResult<T>),
 onFeedUpdate:async(payload,plan)=>{seen.push({payload,plan});attempts++;if(attempts===1)await new Promise<void>(resolve=>{finish=resolve});throw new Error('channel failed')},
 onAuthRequired:async()=>{},onPollSkipped:()=>{maintenance++}});
 const first=poller.pollOnce();await new Promise(resolve=>setImmediate(resolve));
 expect(await poller.pollOnce()).toBeNull();expect(feedCalls).toBe(1);
 finish();await first;await poller.pollOnce();
 expect(feedCalls).toBe(1);expect(attempts).toBe(2);expect(seen[0]).toEqual(seen[1]);expect(maintenance).toBe(2);
 await poller.pollOnce();expect(feedCalls).toBe(2);
});
test.each(['0.6.10','0.7.0','0.7.1','0.8.0','unknown','0.7.1-rc.1'])('scheduled origin is gated for %s', async (version: string)=>{
 const calls:string[][]=[];
 const poller=new FeedPoller({serverName:'test',eigenfluxBin:'eigenflux',pollIntervalOverrideSec:60,
 onHeartbeatStart:async()=>({agent_prompt:'plan',wake_on_empty:false}),
 exec:async<T>(_bin:string,args:string[])=>{calls.push(args);return {kind:'success',data:args[0]==='version'?{cli_version:version}:{items:[],notifications:[]}} as CliResult<T>},
 onFeedUpdate:async()=>{},onAuthRequired:async()=>{}});
 await poller.pollOnce();await poller.pollOnce();expect(calls.filter(args=>args[0]==='version')).toHaveLength(2);
 for(const args of calls.filter(args=>args.includes('poll'))){expect(args.includes('--batch')).toBe(version==='0.7.1'||version==='0.8.0');if(args.includes('--batch'))expect(args[args.indexOf('--batch')+1]).toBe('5');expect(args.includes('--origin')).toBe(version==='0.7.0'||version==='0.7.1'||version==='0.8.0')}
});
test('re-reads the CLI version every cycle so upgrades, downgrades and unreadable versions take effect', async () => {
  const versions: CliResult<unknown>[] = [
    { kind: 'success', data: { cli_version: '0.6.10' } },
    { kind: 'success', data: { cli_version: '0.7.1' } },
    { kind: 'success', data: { cli_version: '0.6.10' } },
    { kind: 'not_installed', bin: 'eigenflux' },
    { kind: 'success', data: { cli_version: '0.7.1' } },
  ];
  const origins: boolean[] = [];
  const batches: boolean[] = [];
  const poller = new FeedPoller({
    serverName: 'test', eigenfluxBin: 'eigenflux', pollIntervalOverrideSec: 60,
    onHeartbeatStart: async () => ({ agent_prompt: 'plan', wake_on_empty: false }),
    exec: async <T>(_bin: string, args: string[]) => {
      if (args[0] === 'version') return versions.shift() as CliResult<T>;
      origins.push(args.includes('--origin'));
      batches.push(args.includes('--batch'));
      return successFeed() as CliResult<T>;
    },
    onFeedUpdate: async () => {}, onAuthRequired: async () => {},
  });
  for (let cycle = 0; cycle < 5; cycle++) await poller.pollOnce();
  expect(origins).toEqual([false, true, false, false, true]);
  expect(batches).toEqual([false, true, false, false, true]);
});

function hungFeedPoller(deliveryTimeoutMs: number, state: { feedCalls: number; deliveries: number }, hangDeliveries = Infinity) {
  return new FeedPoller({
    serverName: 'test', eigenfluxBin: 'eigenflux', pollIntervalOverrideSec: 0.01, deliveryTimeoutMs,
    onHeartbeatStart: async () => ({ agent_prompt: 'plan', wake_on_empty: true }),
    exec: async <T>(_bin: string, args: string[]) => {
      if (args[0] === 'version') return { kind: 'success', data: { cli_version: '0.6.10' } } as CliResult<T>;
      state.feedCalls++;
      return { kind: 'success', data: { items: [{ item_id: String(state.feedCalls) }], notifications: [] } } as CliResult<T>;
    },
    onFeedUpdate: () => (++state.deliveries <= hangDeliveries ? new Promise<void>(() => {}) : Promise.resolve()),
    onAuthRequired: async () => {},
  });
}

async function waitUntil(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a hung delivery times out as a failed attempt, retries once, then Feed polls again', async () => {
  const state = { feedCalls: 0, deliveries: 0 };
  const poller = hungFeedPoller(20, state);
  poller.start();
  try {
    await waitUntil(() => state.feedCalls >= 2);
    // Two timed-out attempts on the first payload before the next pull.
    expect(state.deliveries).toBeGreaterThanOrEqual(2);
  } finally {
    await poller.stop();
  }
});

test('a hung delivery that recovers on retry clears the payload and later cycles pull again', async () => {
  const state = { feedCalls: 0, deliveries: 0 };
  const poller = hungFeedPoller(20, state, 1);
  poller.start();
  try {
    await waitUntil(() => state.feedCalls >= 2);
    expect(state.deliveries).toBeGreaterThanOrEqual(2);
  } finally {
    await poller.stop();
  }
});

test('stop() during a hung delivery returns once the delivery attempt times out', async () => {
  const state = { feedCalls: 0, deliveries: 0 };
  const poller = hungFeedPoller(50, state);
  poller.start();
  await waitUntil(() => state.deliveries === 1);
  const started = Date.now();
  await poller.stop();
  expect(Date.now() - started).toBeLessThan(1_000);
  const feedCallsAtStop = state.feedCalls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(state.feedCalls).toBe(feedCallsAtStop);
});

test('null plan skips all Feed calls but keeps maintenance',async()=>{
 let calls=0,maintenance=0;
 const poller=new FeedPoller({serverName:'test',eigenfluxBin:'eigenflux',pollIntervalOverrideSec:60,onHeartbeatStart:async()=>null,
 exec:async<T>()=>{calls++;return successFeed() as CliResult<T>},onFeedUpdate:async()=>{},onAuthRequired:async()=>{},onPollSkipped:()=>{maintenance++}});
 expect(await poller.pollOnce()).toBeNull();expect(calls).toBe(0);expect(maintenance).toBe(1);
});

test('a missing CLI plan retries the missing-episode notification without polling Feed', async () => {
  let notices = 0, feeds = 0;
  const poller = new FeedPoller({
    serverName:'test',eigenfluxBin:'missing',pollIntervalOverrideSec:600,
    onHeartbeatStart:async()=>({kind:'not_installed'}),
    onCliMissing:async()=>{notices++;if(notices===1)throw new Error('listener unavailable');},
    onFeedUpdate:async()=>{},onAuthRequired:async()=>{},
    exec:async()=>{feeds++;return {kind:'success',data:{} as any};},
  });
  await poller.pollOnce();
  await poller.pollOnce();
  expect(notices).toBe(2);
  expect(feeds).toBe(0);
});
