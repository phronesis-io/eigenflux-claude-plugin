import { test, expect } from 'bun:test';
import { readPollIntervalSec, POLL_INTERVAL_CONFIG_KEY, type ExecFn } from './poll-interval.js';
import { DEFAULT_POLL_INTERVAL_SEC } from './config.js';
import type { CliResult } from './cli-executor.js';

function execReturning(result: CliResult<unknown>): ExecFn {
  return (async () => result) as ExecFn;
}

test('reads a numeric interval from the CLI config', async () => {
  expect(await readPollIntervalSec('eigenflux', 'srv', execReturning({ kind: 'success', data: 120 }))).toBe(120);
});

test('accepts a numeric string and floors fractions', async () => {
  expect(await readPollIntervalSec('eigenflux', 'srv', execReturning({ kind: 'success', data: '90' }))).toBe(90);
  expect(await readPollIntervalSec('eigenflux', 'srv', execReturning({ kind: 'success', data: 90.9 }))).toBe(90);
});

test('falls back to the default on missing value, CLI failure, or garbage', async () => {
  expect(await readPollIntervalSec('eigenflux', 'srv', execReturning({ kind: 'success', data: undefined as unknown }))).toBe(DEFAULT_POLL_INTERVAL_SEC);
  expect(await readPollIntervalSec('eigenflux', 'srv', execReturning({ kind: 'error', error: new Error('boom'), exitCode: 1, stderr: '' }))).toBe(DEFAULT_POLL_INTERVAL_SEC);
  expect(await readPollIntervalSec('eigenflux', 'srv', execReturning({ kind: 'not_installed', bin: 'eigenflux' }))).toBe(DEFAULT_POLL_INTERVAL_SEC);
  expect(await readPollIntervalSec('eigenflux', 'srv', execReturning({ kind: 'success', data: 'abc' }))).toBe(DEFAULT_POLL_INTERVAL_SEC);
});

test('clamps out-of-range values to the default', async () => {
  expect(await readPollIntervalSec('eigenflux', 'srv', execReturning({ kind: 'success', data: 5 }))).toBe(DEFAULT_POLL_INTERVAL_SEC);
  expect(await readPollIntervalSec('eigenflux', 'srv', execReturning({ kind: 'success', data: 100 * 24 * 60 * 60 }))).toBe(DEFAULT_POLL_INTERVAL_SEC);
});

test('never rejects even when exec throws', async () => {
  const throwing: ExecFn = async () => { throw new Error('spawn failed'); };
  expect(await readPollIntervalSec('eigenflux', 'srv', throwing)).toBe(DEFAULT_POLL_INTERVAL_SEC);
});

test('queries the documented config key', async () => {
  let seenArgs: string[] = [];
  const capture: ExecFn = (async (_bin: string, args: string[]) => {
    seenArgs = args;
    return { kind: 'success', data: 600 };
  }) as ExecFn;
  await readPollIntervalSec('eigenflux', 'srv', capture);
  expect(seenArgs).toContain(POLL_INTERVAL_CONFIG_KEY);
  expect(seenArgs).toContain('srv');
});
