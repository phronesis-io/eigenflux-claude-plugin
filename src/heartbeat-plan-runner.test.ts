import { expect, test } from 'bun:test';
import { HeartbeatPlanRunner } from './heartbeat-plan-runner.js';
import type { CliResult } from './cli-executor.js';

test('runs the thin Heartbeat plan with the stable Home', async () => {
  const calls: Array<{ bin: string; args: string[]; parseJson?: boolean }> = [];
  const exec = async <T>(bin: string, args: string[], options?: { parseJson?: boolean }) => {
    calls.push({ bin, args, parseJson: options?.parseJson });
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
      parseJson: undefined,
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
