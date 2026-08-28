import { expect, test } from 'bun:test';
import { HeartbeatPlanRunner } from './heartbeat-plan-runner.js';
import type { CliResult } from './cli-executor.js';

test('runs the thin Heartbeat plan with the stable Home', async () => {
  const calls: Array<{ bin: string; args: string[]; parseJson?: boolean }> = [];
  const exec = async <T>(bin: string, args: string[], options?: { parseJson?: boolean }) => {
    calls.push({ bin, args, parseJson: options?.parseJson });
    return { kind: 'success', data: 'plan' } as CliResult<T>;
  };
  const runner = new HeartbeatPlanRunner(
    '/opt/eigenflux',
    '/stable/claude/.eigenflux',
    exec
  );

  expect(await runner.run()).toBe(true);
  expect(calls).toEqual([
    {
      bin: '/opt/eigenflux',
      args: [
        '--homedir',
        '/stable/claude/.eigenflux',
        'heartbeat',
        'plan',
        '--format',
        'agent',
      ],
      parseJson: false,
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
  const runner = new HeartbeatPlanRunner('eigenflux', '/stable/home', exec);
  expect(await runner.run()).toBe(false);
});
