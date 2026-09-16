import { expect, test } from 'bun:test';
import { FeedPoller } from './feed-poller.js';
import type { CliResult } from './cli-executor.js';

test('stopping during a plan prevents a later Feed request', async () => {
  let finish!: () => void; let polls = 0;
  const poller = new FeedPoller({
    eigenfluxBin: 'ef', serverName: 'prod', pollIntervalOverrideSec: 600,
    async onHeartbeatStart() { await new Promise<void>((resolve) => { finish = resolve; }); return null; },
    async onFeedUpdate() {}, async onAuthRequired() {},
    exec: async <T>() => { polls++; return { kind: 'success', data: {} } as CliResult<T>; },
  });
  const pending = poller.pollOnce();
  await poller.stop(); finish(); await pending;
  expect(polls).toBe(0);
});

test('stopping during Feed polling suppresses post-poll hooks and delivery', async () => {
  let finish!: () => void; let effects = 0;
  const poller = new FeedPoller({
    eigenfluxBin: 'ef', serverName: 'prod', pollIntervalOverrideSec: 600,
    async onFeedUpdate() { effects++; }, async onAuthRequired() { effects++; },
    async onPollSuccess() { effects++; },
    exec: async <T>() => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { kind: 'success', data: { items: [{}], notifications: [] } } as CliResult<T>;
    },
  });
  const pending = poller.pollOnce();
  await poller.stop(); finish(); await pending;
  expect(effects).toBe(0);
});
