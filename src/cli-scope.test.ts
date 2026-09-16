import { expect, test } from 'bun:test';
import { cliScopeArgs } from './cli-executor.js';
import { leaderSocketPath } from './instance-leader.js';

test('every CLI operation explicitly pins Home and server without replacing an explicit scope', () => {
  expect(cliScopeArgs(['version'], '/home/exact', 'prod')).toEqual(['--homedir', '/home/exact', '--server', 'prod', 'version']);
  expect(cliScopeArgs(['--homedir', '/other', 'feed', 'poll', '-s', 'test'], '/home/exact', 'prod')).toEqual(['--homedir', '/other', 'feed', 'poll', '-s', 'test']);
});

test('leader isolation uses normalized Home and server and provides Windows named pipes', () => {
  const first = leaderSocketPath('/tmp/home/../home', 'same');
  expect(first).toBe(leaderSocketPath('/tmp/home', 'same'));
  expect(first).not.toBe(leaderSocketPath('/tmp/other', 'same'));
  expect(first).not.toBe(leaderSocketPath('/tmp/home', 'other'));
  expect(leaderSocketPath('/tmp/home', 'same', 'win32')).toMatch(/^\\\\\.\\pipe\\eigenflux-claude-[a-f0-9]{32}$/);
});
