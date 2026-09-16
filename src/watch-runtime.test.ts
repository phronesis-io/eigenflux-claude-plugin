import { expect, test } from 'bun:test';
import { StreamSupervisor, WatchEventRouter, supportsWatch } from './watch-runtime.js';
import type { WatchEvent } from './watch-client.js';

const event = (type: string, id = type): WatchEvent => ({ schema_version: 'eigenflux_watch.v1', type, state_scope: 'account', event_id: id, data: {} });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('versions select watch only with a verified 1.0.0+ CLI', () => {
  for (const version of ['1.0.0', '1.0.1', '2.0.0', 'v1.0.0']) expect(supportsWatch(version)).toBe(true);
  for (const version of [null, '0.0.99', 'unknown', '1.0.0-rc.1', '1.not.version']) expect(supportsWatch(version)).toBe(false);
});

test('legacy fallback upgrades to watch only after legacy stop finishes', async () => {
  const actions: string[] = [];
  let version = '0.0.46';
  let finish!: () => void;
  const legacy = { start() { actions.push('legacy:start'); }, async stop() { actions.push('legacy:stop'); await new Promise<void>((resolve) => { finish = resolve; }); } };
  const watch = { start() { actions.push('watch:start'); }, async stop() { actions.push('watch:stop'); } };
  const supervisor = new StreamSupervisor(legacy, watch, async () => version);
  await supervisor.start(); expect(supervisor.usingWatch).toBe(false);
  version = '1.0.0'; const upgrading = supervisor.refresh(); await settle();
  expect(actions).toEqual(['legacy:start', 'legacy:stop']);
  finish(); await upgrading;
  expect(actions).toEqual(['legacy:start', 'legacy:stop', 'watch:start']);
  expect(supervisor.usingWatch).toBe(true);
  await supervisor.stop();
});

test('leadership loss during version selection suppresses late process startup', async () => {
  let finish!: (version: string) => void;
  let starts = 0;
  const client = { start() { starts++; }, async stop() {} };
  const supervisor = new StreamSupervisor(client, client, () => new Promise((resolve) => { finish = resolve; }));
  const starting = supervisor.start(); const stopping = supervisor.stop();
  finish('1.0.0'); await starting; await stopping;
  expect(starts).toBe(0);
});

test('due events route without Feed, coalesce in-flight only, and remain responsive to PM', async () => {
  const plans: string[] = []; const notices: string[] = []; const pms: string[] = []; let profiles = 0;
  let finish!: () => void;
  const router = new WatchEventRouter({
    plans: { async cancelQueued() {}, async run(mode) { plans.push(mode!); if (mode === 'maintenance') await new Promise<void>((resolve) => { finish = resolve; }); return { agent_prompt: `central:${mode}`, wake_on_empty: true }; } },
    async refreshProfile() { profiles++; }, async deliverPm(event) { pms.push(event.type); },
    async notify(type, content) { notices.push(`${type}:${content}`); },
  });
  router.start();
  const maintenance = router.handle(event('maintenance_due'));
  const duplicate = router.handle(event('maintenance_due', 'second'));
  await router.handle(event('control_pending'));
  await router.handle(event('profile_review_due'));
  await router.handle(event('pm_push'));
  expect(plans).toEqual(['maintenance', 'control']); expect(profiles).toBe(1); expect(pms).toEqual(['pm_push']);
  expect(notices).toEqual(['control_plan:central:control']);
  finish(); await maintenance; await duplicate;
  await router.handle(event('control_pending', 'later'));
  expect(plans).toEqual(['maintenance', 'control', 'control']);
  expect(notices).toContain('maintenance_plan:central:maintenance');
  await router.stop();
});

test('empty plans stay silent and leadership loss suppresses late plan notification', async () => {
  let finish!: () => void; const notices: string[] = [];
  const router = new WatchEventRouter({
    plans: { async cancelQueued() {}, async run(mode) { if (mode === 'maintenance') await new Promise<void>((resolve) => { finish = resolve; }); return { agent_prompt: mode === 'control' ? '' : 'central', wake_on_empty: false }; } },
    async refreshProfile() {}, async deliverPm() {}, async notify(type) { notices.push(type); },
  });
  router.start(); await router.handle(event('control_pending'));
  const running = router.handle(event('maintenance_due')); const stopping = router.stop();
  finish(); await running; await stopping;
  expect(notices).toHaveLength(0);
});

test('router stop cancels queued central CLI work and awaits the active command', async () => {
  const { HeartbeatPlanRunner } = await import('./heartbeat-plan-runner.js');
  const calls: string[][] = []; const notices: string[] = []; let finish!: () => void;
  const runner = new HeartbeatPlanRunner('ef', '/home', 'prod', async <T>(_bin: string, args: string[]) => {
    calls.push(args);
    await new Promise<void>((resolve) => { finish = resolve; });
    return { kind: 'success', data: { agent_prompt: 'central', wake_on_empty: true } as T };
  });
  const router = new WatchEventRouter({
    plans: runner, async refreshProfile() {}, async deliverPm() {}, async notify(type) { notices.push(type); },
  });
  router.start();
  const active = runner.run('full', { watchManaged: true });
  const queued = router.handle(event('control_pending'));
  await settle();
  let stopped = false;
  const stopping = router.stop().then(() => { stopped = true; });
  await settle(); expect(stopped).toBe(false);
  finish(); await Promise.all([active, queued, stopping]);
  expect(calls).toHaveLength(1); expect(notices).toHaveLength(0);
});
