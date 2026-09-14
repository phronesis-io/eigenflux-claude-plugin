#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mock } from 'bun:test';

// Load the real channel wiring and adapters; replace only external processes,
// MCP transport, and the host scheduler. No live CLI or user context is read.
mock.module('../src/config.js', () => ({
  CONFIG: {
    EIGENFLUX_BIN: '/mock/eigenflux', EIGENFLUX_SERVER: 'test', EIGENFLUX_HOME: '/mock/home',
    PLUGIN_VERSION: 'test', EXPECTED_CLI_VERSION: '0.0.46', FEED_POLL_INTERVAL_OVERRIDE_SEC: 600,
  },
  DEFAULT_POLL_INTERVAL_SEC: 600, MIN_POLL_INTERVAL_SEC: 10, MAX_POLL_INTERVAL_SEC: 86400,
}));

const events = [];
let finishProfile;
let profileCalls = 0;
const profileResult = new Promise((resolve) => { finishProfile = resolve; });
mock.module('../src/cli-executor.js', () => ({
  execEigenflux: async (_bin, args) => {
    if (args[0] === 'profile') {
      profileCalls += 1;
      return profileResult;
    }
    if (args[0] === 'feed' && args[1] === 'poll') {
      return { kind: 'success', data: { items: [{ item_id: '1' }], notifications: [], has_more: false, output_contract: 'CENTRAL RULES' } };
    }
    return { kind: 'success', data: '' };
  },
}));
mock.module('../src/claude-code-context.js', () => ({
  EMPTY_CONTEXT: { memoryDirs: [], sessionSnippets: [] },
  collectClaudeCodeContext: () => ({ memoryDirs: [], sessionSnippets: [] }),
}));
mock.module('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    async connect() {}
    async notification(event) { events.push(event.params.meta.event_type); }
  },
}));
mock.module('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
mock.module('../src/instance-leader.js', () => ({
  detectLeaderPriority: () => 0,
  LeaderElector: class {
    constructor(config) { this.config = config; }
    start() { this.config.onAcquire(); }
    stop() {}
  },
}));
mock.module('../src/pm-stream.js', () => ({ PmStreamClient: class { start() {} stop() {} } }));
mock.module('../src/feedback-flush-loop.js', () => ({ FeedbackFlushLoop: class { start() {} stop() {} kick() {} } }));
mock.module('../src/cli-version.js', () => ({ getInstalledCliVersion: async () => '0.0.46', isCliOutdated: () => false }));
mock.module('../src/heartbeat-plan-runner.js', () => ({
  HeartbeatPlanRunner: class { async run() { return { agent_prompt: 'CURRENT CENTRAL PLAN', wake_on_empty: false }; } },
}));

const { FeedPoller } = await import('../src/feed-poller.ts');
let poller;
mock.module('../src/feed-poller.js', () => ({
  FeedPoller: class extends FeedPoller {
    constructor(config) { super(config); poller = this; }
    start() {} // The test explicitly triggers each heartbeat.
  },
}));
await import('../src/channel.ts');

let firstDone = false;
const first = poller.pollOnce().then(() => { firstDone = true; });
await new Promise((resolve) => setImmediate(resolve));
try {
  assert.equal(firstDone, true, 'a pending profile command must not hold the completed Feed poll');
  assert.deepEqual(events, ['feed_update'], 'Feed must arrive before the slow profile task completes');
  await poller.pollOnce();
  assert.equal(profileCalls, 1, 'overlapping profile checks remain deduplicated');
  assert.deepEqual(events, ['feed_update', 'feed_update']);
} finally {
  finishProfile({ kind: 'success', data: 'CENTRAL PROFILE TASK' });
  await first;
}
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(events, ['feed_update', 'feed_update', 'profile_refresh']);
console.log('channel profile latency regression passed');
