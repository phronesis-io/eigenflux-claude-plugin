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
test.each(['0.6.10','0.7.0','0.8.0','unknown'])('scheduled origin is gated for %s', async version=>{
 const calls:string[][]=[];
 const poller=new FeedPoller({serverName:'test',eigenfluxBin:'eigenflux',pollIntervalOverrideSec:60,
 onHeartbeatStart:async()=>({agent_prompt:'plan',wake_on_empty:false}),
 exec:async<T>(_bin:string,args:string[])=>{calls.push(args);return {kind:'success',data:args[0]==='version'?{cli_version:version}:{items:[],notifications:[]}} as CliResult<T>},
 onFeedUpdate:async()=>{},onAuthRequired:async()=>{}});
 await poller.pollOnce();await poller.pollOnce();expect(calls.filter(args=>args[0]==='version')).toHaveLength(1);
 for(const args of calls.filter(args=>args.includes('poll'))){expect(args.includes('--origin')).toBe(version==='0.7.0'||version==='0.8.0')}
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
