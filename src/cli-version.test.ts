import { test, expect } from 'bun:test';
import { getInstalledCliVersion, isCliOutdated, type ExecFn } from './cli-version.js';

test('isCliOutdated compares major.minor.patch', () => {
  expect(isCliOutdated('0.0.16', '0.0.17')).toBe(true);
  expect(isCliOutdated('0.0.17', '0.0.17')).toBe(false);
  expect(isCliOutdated('0.0.18', '0.0.17')).toBe(false);
  expect(isCliOutdated('0.1.0', '0.0.17')).toBe(false);
  expect(isCliOutdated('1.0.0', '2.0.0')).toBe(true);
});

test('isCliOutdated never nags on unknown/bad data', () => {
  expect(isCliOutdated(null, '0.0.17')).toBe(false);
  expect(isCliOutdated('garbage', '0.0.17')).toBe(false);
  expect(isCliOutdated('', '0.0.17')).toBe(false);
});

test('getInstalledCliVersion reads cli_version from `eigenflux version`', async () => {
  const exec: ExecFn = (async () => ({ kind: 'success', data: { cli_version: '0.0.19' } })) as ExecFn;
  expect(await getInstalledCliVersion('eigenflux', exec)).toBe('0.0.19');
});

test('getInstalledCliVersion returns null when the CLI is missing or output is unusable', async () => {
  const missing: ExecFn = (async () => ({ kind: 'not_installed', bin: 'eigenflux' })) as ExecFn;
  expect(await getInstalledCliVersion('eigenflux', missing)).toBe(null);
  const junk: ExecFn = (async () => ({ kind: 'success', data: {} })) as ExecFn;
  expect(await getInstalledCliVersion('eigenflux', junk)).toBe(null);
  const throwing: ExecFn = (async () => { throw new Error('boom'); }) as ExecFn;
  expect(await getInstalledCliVersion('eigenflux', throwing)).toBe(null);
});
