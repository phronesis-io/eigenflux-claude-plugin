#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mock } from 'bun:test';

mock.module('../src/config.js', () => ({
  CONFIG: {
    EIGENFLUX_BIN: '/mock/eigenflux', EIGENFLUX_SERVER: 'test', EIGENFLUX_HOME: '/mock/home',
    PLUGIN_VERSION: 'test', EXPECTED_CLI_VERSION: '0.0.46', FEED_POLL_INTERVAL_OVERRIDE_SEC: 600,
  },
  DEFAULT_POLL_INTERVAL_SEC: 600, MIN_POLL_INTERVAL_SEC: 10, MAX_POLL_INTERVAL_SEC: 86400,
}));
const events = [];
const calls = [];
let profileCalls = 0;
mock.module('../src/cli-executor.js', () => ({
  cliChildEnv: () => ({ ...process.env }),
  execEigenflux: async (_bin, args) => {
    calls.push(args);
    if (args.includes('refresh-task')) {
      profileCalls++;
      return { kind: 'success', data: 'CENTRAL PROFILE TASK' };
    }
    if (args.includes('heartbeat')) return { kind: 'success', data: { agent_prompt: args.includes('--control-only') ? 'CONTROL PLAN' : 'MAINTENANCE PLAN', wake_on_empty: true } };
    if (args[0] === 'feed' && args[1] === 'poll') return { kind: 'error', error: new Error('Feed unavailable'), exitCode: 1, stderr: 'offline' };
    return { kind: 'success', data: '' };
  },
}));
mock.module('../src/claude-code-context.js', () => ({
  EMPTY_CONTEXT: { memoryDirs: [], sessionSnippets: [] },
  collectClaudeCodeContext: () => ({ memoryDirs: [], sessionSnippets: [] }),
}));
mock.module('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class { async connect() {} async notification(event) { events.push(event.params); } },
}));
mock.module('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
mock.module('../src/instance-leader.js', () => ({
  detectLeaderPriority: () => 0, leaderSocketPath: () => '/mock/leader.sock', normalizeHome: (home) => home,
  LeaderElector: class { constructor(config) { this.config = config; } start() { this.config.onAcquire(); } stop() {} },
}));
let legacyStarts = 0;
mock.module('../src/pm-stream.js', () => ({ PmStreamClient: class { start() { legacyStarts++; } async stop() {} } }));
let watchConfig;
let watchStarts = 0;
let watchStops = 0;
mock.module('../src/watch-client.js', () => ({ WatchClient: class { constructor(config) { watchConfig = config; } start() { watchStarts++; } async stop() { watchStops++; } } }));
mock.module('../src/feedback-flush-loop.js', () => ({ FeedbackFlushLoop: class { start() {} stop() {} kick() {} } }));
mock.module('../src/cli-version.js', () => ({ getInstalledCliVersion: async () => '1.0.0', isCliOutdated: () => false }));

const { FeedPoller } = await import('../src/feed-poller.ts');
let poller;
let pollConfig;
mock.module('../src/feed-poller.js', () => ({
  FeedPoller: class extends FeedPoller {
    constructor(config) { super(config); poller = this; pollConfig = config; }
    start() {}
  },
}));
await import('../src/channel.ts');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(watchStarts, 1);
assert.equal(legacyStarts, 0);
await pollConfig.onPollSuccess();
assert.equal(profileCalls, 0, 'watch mode suppresses old per-heartbeat profile refresh');
await poller.pollOnce();
assert.equal(events.length, 0, 'failed Feed does not deliver a Feed event');
assert.equal(calls.filter((args) => args.includes('heartbeat')).length, 1);
assert.ok(calls.find((args) => args.includes('heartbeat')).includes('--watch-managed'));
const send = (type) => watchConfig.onEvent({ schema_version: 'eigenflux_watch.v1', type, event_id: type, state_scope: 'account', data: {} });
await send('maintenance_due');
await send('control_pending');
await send('profile_review_due');
await send('pm_push');
assert.deepEqual(events.map((event) => event.meta.event_type), ['maintenance_plan', 'control_plan', 'profile_refresh', 'pm_update']);
assert.equal(events[0].content, 'MAINTENANCE PLAN');
assert.equal(events[1].content, 'CONTROL PLAN');
assert.equal(profileCalls, 1);
for (const args of calls.filter((args) => args.includes('--control-only') || args.includes('--maintenance-only'))) {
  assert.deepEqual(args.slice(0, 4), ['--homedir', '/mock/home', '--server', 'test']);
  assert.equal(args.includes('--watch-managed'), false, 'dedicated maintenance and control plans retain their owner');
}
await watchConfig.onFatal('identity changed');
await new Promise((resolve) => setImmediate(resolve));
assert.equal(watchStops, 1);
const eventsBeforeStop = events.length;
await pollConfig.onPollSuccess();
await send('control_pending');
assert.equal(events.length, eventsBeforeStop);
assert.equal(profileCalls, 1);
console.log('channel watch wiring regression passed');
