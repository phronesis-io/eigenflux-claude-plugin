import { test, expect } from 'bun:test';
import { SettingsReporter, type ExecFn } from './settings-reporter.js';
import type { CliResult } from './cli-executor.js';

test('pushes mode=plugin for the configured server', async () => {
  const calls: string[][] = [];
  const exec: ExecFn = (async (_bin: string, args: string[]) => {
    calls.push(args);
    return { kind: 'success', data: '' } as CliResult<unknown>;
  }) as ExecFn;
  const reporter = new SettingsReporter('eigenflux', 'srv', exec);

  expect(await reporter.report()).toBe(true);
  expect(calls.length).toBe(1);
  expect(calls[0]).toEqual(['settings', 'push', '--mode', 'plugin', '-s', 'srv']);
});

test('is re-entrant safe: a concurrent report is skipped', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const exec: ExecFn = (async () => {
    await gate;
    return { kind: 'success', data: '' };
  }) as ExecFn;
  const reporter = new SettingsReporter('eigenflux', 'srv', exec);

  const first = reporter.report();
  const second = await reporter.report(); // while first is in flight
  expect(second).toBe(false);
  release();
  expect(await first).toBe(true);
});

test('failures are swallowed and reported as false', async () => {
  const failing: ExecFn = (async () => ({ kind: 'auth_required', stderr: '' })) as ExecFn;
  expect(await new SettingsReporter('eigenflux', 'srv', failing).report()).toBe(false);
  const throwing: ExecFn = (async () => { throw new Error('boom'); }) as ExecFn;
  expect(await new SettingsReporter('eigenflux', 'srv', throwing).report()).toBe(false);
});
