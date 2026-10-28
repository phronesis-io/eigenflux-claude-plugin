#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mock } from 'bun:test';

// Exercise real channel wiring and adapters with external processes and MCP
// delivery replaced. No login, model invocation, or real notification occurs.
const events = [];
let failNextSend = false;
let feedCalls = 0;
let pmConfig;
let poller;
let profile;
let now = 1_000;
const originalNow = Date.now;
Date.now = () => now;
const notice = {
  schema_version: 'eigenflux_auth_required.v1', status: 'auth_required',
  code: 'IDENTITY_UNAVAILABLE', home: '/mock/home', server: 'test',
  checks_blocked: true, notification_required: true,
  instruction: 'CURRENT CLI INSTRUCTION', owner_action: 'CURRENT OWNER ACTION',
};
const detail = `diagnostic\n${JSON.stringify(notice)}`;
let planResult = { kind: 'auth_required', stderr: detail };
let profileResult = { kind: 'auth_required', stderr: detail };

mock.module('../src/config.js', () => ({
  CONFIG: {
    EIGENFLUX_BIN: '/mock/eigenflux', EIGENFLUX_SERVER: 'test', EIGENFLUX_HOME: '/mock/home',
    PLUGIN_VERSION: 'test', EXPECTED_CLI_VERSION: '0.6.7', FEED_POLL_INTERVAL_OVERRIDE_SEC: 600,
  },
  DEFAULT_POLL_INTERVAL_SEC: 600, MIN_POLL_INTERVAL_SEC: 10, MAX_POLL_INTERVAL_SEC: 86400,
}));
mock.module('../src/cli-executor.js', () => ({
  execEigenflux: async (_bin, args) => {
    if (args.includes('heartbeat')) return planResult;
    if (args[0] === 'profile') return profileResult;
    if (args[0] === 'feed' && args[1] === 'poll') {
      feedCalls += 1;
      return { kind: 'success', data: { items: [], notifications: [], has_more: false } };
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
    async notification(event) {
      if (failNextSend) { failNextSend = false; throw new Error('mock transport unavailable'); }
      events.push(event.params);
    }
  },
}));
mock.module('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
mock.module('../src/instance-leader.js', () => ({
  detectLeaderPriority: () => 2, PRIORITY_DEV_CHANNEL: 2,
  LeaderElector: class {
    constructor(config) { this.config = config; }
    start() { this.config.onAcquire(); }
    stop() {}
  },
}));
mock.module('../src/pm-stream.js', () => ({
  PmStreamClient: class { constructor(config) { pmConfig = config; } start() {} stop() {} },
}));
mock.module('../src/feedback-flush-loop.js', () => ({ FeedbackFlushLoop: class { start() {} stop() {} kick() {} } }));
mock.module('../src/cli-version.js', () => ({ getInstalledCliVersion: async () => '0.6.7', supportsFeedBatches: () => false, supportsHeartbeatOrigin: () => false, isCliOutdated: () => false }));
const { FeedPoller } = await import('../src/feed-poller.ts');
mock.module('../src/feed-poller.js', () => ({
  FeedPoller: class extends FeedPoller {
    constructor(config) { super(config); poller = this; }
    start() {}
  },
}));
const { ProfileRefresher } = await import('../src/profile-refresher.ts');
mock.module('../src/profile-refresher.js', () => ({
  ProfileRefresher: class extends ProfileRefresher {
    constructor(config) { super(config); profile = this; }
  },
}));
await import('../src/channel.ts');

try {
  await poller.pollOnce();
  assert.equal(feedCalls, 0, 'failed plan authentication must stop before Feed');
  assert.equal(events.length, 1);
  const content = JSON.parse(events[0].content);
  assert.equal(events[0].meta.event_type, 'auth_required');
  assert.equal(content.detail, detail);
  assert.deepEqual(content.notice, notice, 'CLI owner_action and instruction must pass unchanged');
  assert.equal(content.homedir, '/mock/home');
  assert.equal(content.server, 'test');

  await poller.pollOnce();
  await pmConfig.onAuthRequired(detail);
  await profile.refresh();
  assert.equal(events.length, 1, 'all sources share the successful-send cooldown');

  now += 5 * 60 * 1000;
  await pmConfig.onAuthRequired(detail);
  assert.equal(events.length, 2, 'a persistent stream failure must be reminded again');
  now += 5 * 60 * 1000;
  await profile.refresh();
  assert.equal(events.length, 3, 'profile-only authentication failures must notify');

  now += 5 * 60 * 1000;
  failNextSend = true;
  await poller.pollOnce();
  assert.equal(feedCalls, 0, 'failed reminder delivery cannot cause a second authentication attempt');
  await poller.pollOnce();
  assert.equal(events.length, 4, 'failed sends must remain retryable');

  planResult = { kind: 'error', error: new Error('credential acquisition unavailable'), exitCode: 2,
    stderr: 'CLI UNAVAILABLE', authenticationUnavailable: true };
  await poller.pollOnce();
  assert.equal(feedCalls, 0);
  assert.equal(events.length, 4, 'credential service failures must not request login');

  profileResult = { kind: 'success', data: '' };
  for (const code of [503, 429]) {
    planResult = { kind: 'error', error: new Error(`ordinary endpoint HTTP ${code}`), exitCode: 2, stderr: `HTTP ${code}` };
    await poller.pollOnce();
  }
  planResult = { kind: 'future_status' };
  await poller.pollOnce();
  assert.equal(feedCalls, 0, 'unavailable plans must never consume Feed');
  await pmConfig.onAuthRequired(detail);
  assert.equal(events.length, 4, 'a skipped Feed cannot reset the shared cooldown');
  planResult = { kind: 'success', data: { agent_prompt: 'CURRENT PLAN', wake_on_empty: false } };
  await poller.pollOnce();
  assert.equal(feedCalls, 1);
  await pmConfig.onAuthRequired(detail);
  assert.equal(events.length, 5, 'a successful Feed check resets the shared cooldown');
  console.log('channel authentication wiring regression passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  Date.now = originalNow;
}
