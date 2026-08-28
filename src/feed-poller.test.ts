import { expect, test } from 'bun:test';
import { FeedPoller, type ExecFn } from './feed-poller.js';
import type { CliResult } from './cli-executor.js';

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
    onHeartbeatStart: async () => { order.push('plan'); },
    exec: (async <T>() => {
      order.push('feed');
      return successFeed() as CliResult<T>;
    }) as ExecFn,
    onFeedUpdate: async () => {},
    onAuthRequired: async () => {},
  });

  expect(await poller.pollOnce()).not.toBeNull();
  expect(order).toEqual(['plan', 'feed']);
});

test('continues polling Feed when the Heartbeat plan hook fails', async () => {
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

  expect(await poller.pollOnce()).not.toBeNull();
  expect(feedCalls).toBe(1);
});
