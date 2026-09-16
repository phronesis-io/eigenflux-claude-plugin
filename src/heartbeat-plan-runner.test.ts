import { expect, test } from 'bun:test';
import { HeartbeatPlanRunner } from './heartbeat-plan-runner.js';
import type { CliResult, ExecOptions } from './cli-executor.js';

test('runs the thin Heartbeat plan with the stable Home', async () => {
  const calls: Array<{ bin: string; args: string[]; options?: ExecOptions }> = [];
  const exec = async <T>(bin: string, args: string[], options?: ExecOptions) => {
    calls.push({ bin, args, options });
    return { kind: 'success', data: { agent_prompt: 'CURRENT CENTRAL PLAN', wake_on_empty: true } } as CliResult<T>;
  };
  const runner = new HeartbeatPlanRunner(
    '/opt/eigenflux',
    '/stable/claude/.eigenflux',
    'staging',
    exec
  );

  expect(await runner.run()).toEqual({ agent_prompt: 'CURRENT CENTRAL PLAN', wake_on_empty: true });
  expect(calls).toEqual([
    {
      bin: '/opt/eigenflux',
      args: [
        '--homedir',
        '/stable/claude/.eigenflux',
        '--server',
        'staging',
        'heartbeat',
        'plan',
        '--format',
        'json',
      ],
      options: { timeout: 300_000 },
    },
  ]);
});

test('does not interrupt the plugin heartbeat when the plan fails', async () => {
  const exec = async <T>() => ({
    kind: 'error',
    error: new Error('offline'),
    exitCode: 1,
    stderr: 'offline',
  } as CliResult<T>);
  const runner = new HeartbeatPlanRunner('eigenflux', '/stable/home', 'staging', exec);
  expect(await runner.run()).toBeNull();
});

test('rejects a legacy plan without the central wake decision', async () => {
  const exec = async <T>() => ({
    kind: 'success', data: { agent_prompt: 'legacy plan' },
  } as CliResult<T>);
  const runner = new HeartbeatPlanRunner('eigenflux', '/stable/home', 'staging', exec);
  expect(await runner.run()).toBeNull();
});

test('dedicated modes serialize maintenance and control and preserve empty central output', async () => {
  const calls: string[][] = [];
  let finish!: () => void;
  const exec = async <T>(_bin: string, args: string[]) => {
    calls.push(args);
    if (args.includes('--maintenance-only')) await new Promise<void>((resolve) => { finish = resolve; });
    return { kind: 'success', data: { agent_prompt: '', wake_on_empty: false } } as CliResult<T>;
  };
  const runner = new HeartbeatPlanRunner('ef', '/stable/home', 'prod', exec);
  const maintenance = runner.run('maintenance');
  const duplicate = runner.run('maintenance');
  const control = runner.run('control');
  await new Promise((resolve) => setImmediate(resolve));
  expect(calls).toHaveLength(1);
  expect(maintenance).toBe(duplicate);
  finish();
  await maintenance;
  expect(await control).toEqual({ agent_prompt: '', wake_on_empty: false });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain('--maintenance-only'); expect(calls[1]).toContain('--control-only');
  expect(calls.every((args) => args.slice(0, 4).join('|') === '--homedir|/stable/home|--server|prod')).toBe(true);
});

test('watch-managed belongs only to full plans and is absent from legacy fallback', async () => {
  const calls: string[][] = [];
  const exec = async <T>(_bin: string, args: string[]) => {
    calls.push(args);
    return { kind: 'success', data: { agent_prompt: 'CENTRAL PLAN', wake_on_empty: false } } as CliResult<T>;
  };
  const runner = new HeartbeatPlanRunner('ef', '/stable/.eigenflux', 'prod', exec);
  await runner.run('full', { watchManaged: true });
  await runner.run();
  await runner.run('maintenance', { watchManaged: true });
  await runner.run('control', { watchManaged: true });
  expect(calls).toHaveLength(4);
  expect(calls[0]).toContain('--watch-managed');
  expect(calls[1]).not.toContain('--watch-managed');
  expect(calls[2]).toContain('--maintenance-only');
  expect(calls[2]).not.toContain('--watch-managed');
  expect(calls[3]).toContain('--control-only');
  expect(calls[3]).not.toContain('--watch-managed');
});

test('legacy and watch-managed full plans do not share an in-flight result', async () => {
  const calls: string[][] = [];
  const exec = async <T>(_bin: string, args: string[]) => {
    calls.push(args);
    return { kind: 'success', data: { agent_prompt: 'CENTRAL PLAN', wake_on_empty: false } } as CliResult<T>;
  };
  const runner = new HeartbeatPlanRunner('ef', '/stable/.eigenflux', 'prod', exec);
  await Promise.all([runner.run(), runner.run('full', { watchManaged: true })]);
  expect(calls).toHaveLength(2);
  expect(calls[0]).not.toContain('--watch-managed');
  expect(calls[1]).toContain('--watch-managed');
});

test('cancelQueued preserves the active plan and cancels work from the stopped owner', async () => {
  const calls: string[][] = []; let finish!: () => void;
  const exec = async <T>(_bin: string, args: string[]) => {
    calls.push(args);
    if (calls.length === 1) await new Promise<void>((resolve) => { finish = resolve; });
    return { kind: 'success', data: { agent_prompt: 'central', wake_on_empty: true } } as CliResult<T>;
  };
  const runner = new HeartbeatPlanRunner('ef', '/home', 'prod', exec);
  const active = runner.run('maintenance');
  const queued = runner.run('control');
  await new Promise((resolve) => setImmediate(resolve));
  runner.cancelQueued();
  const nextOwner = runner.run('control');
  finish();
  expect(await active).not.toBeNull(); expect(await queued).toBeNull();
  expect(await nextOwner).not.toBeNull();
  expect(calls).toHaveLength(2);
});
