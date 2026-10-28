#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mock } from 'bun:test';

const priority = Number(process.env.EF_TEST_LEADER_PRIORITY);
if (!priority) {
  for (const value of [1, 2]) {
    const result = spawnSync(process.execPath, [import.meta.filename], {
      env: { ...process.env, EF_TEST_LEADER_PRIORITY: String(value) }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
  console.log('channel Feed leadership regression passed');
} else {
  let feeds = 0, settings = 0, pmStarts = 0;
  let leader;
  const feedDisabledWarnings = [];
  const warn = console.warn;
  console.warn = (...args) => {
    const line = args.join(' ');
    if (line.includes('Feed polling disabled')) feedDisabledWarnings.push(line);
    else warn(...args);
  };
  mock.module('../src/config.js', () => ({CONFIG: {
    EIGENFLUX_BIN: '/mock/eigenflux', EIGENFLUX_SERVER: 'test', EIGENFLUX_HOME: '/mock/home',
    PLUGIN_VERSION: 'test', EXPECTED_CLI_VERSION: '0.6.7', FEED_POLL_INTERVAL_OVERRIDE_SEC: 600,
  }, DEFAULT_POLL_INTERVAL_SEC: 600, MIN_POLL_INTERVAL_SEC: 10, MAX_POLL_INTERVAL_SEC: 86400}));
  mock.module('../src/cli-executor.js', () => ({execEigenflux: async (_bin,args) => {
    if (args[0] === 'settings') settings++;
    if (args[0] === 'feed' && args[1] === 'poll') { feeds++; return {kind:'success',data:{items:[],notifications:[]}}; }
    return {kind:'success',data:''};
  }}));
  mock.module('@modelcontextprotocol/sdk/server/index.js', () => ({Server: class {async connect() {} async notification() {}}}));
  mock.module('@modelcontextprotocol/sdk/server/stdio.js', () => ({StdioServerTransport: class {}}));
  mock.module('../src/instance-leader.js', () => ({detectLeaderPriority:()=>priority,PRIORITY_DEV_CHANNEL:2,
    LeaderElector:class {constructor(config){leader=config;} start(){leader.onAcquire();} stop(){}}}));
  mock.module('../src/pm-stream.js', () => ({PmStreamClient:class {start(){pmStarts++;} stop(){}}}));
  mock.module('../src/profile-refresher.js', () => ({ProfileRefresher:class {start(){} stop(){} async refresh(){}}}));
  mock.module('../src/feedback-flush-loop.js', () => ({FeedbackFlushLoop:class {start(){} stop(){} kick(){}}}));
  mock.module('../src/cli-version.js', () => ({getInstalledCliVersion:async()=>'0.7.0',supportsFeedBatches: () => false, supportsHeartbeatOrigin:()=>true,isCliOutdated:()=>false}));
  mock.module('../src/heartbeat-plan-runner.js', () => ({HeartbeatPlanRunner:class {async run(){return {agent_prompt:'CURRENT PLAN',wake_on_empty:false};}}}));
  await import('../src/channel.ts');
  // channel.ts installs an uncaughtException logger, so failures must set the exit code explicitly.
  try {
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(feeds,priority===2?1:0,'only a channel-enabled leader may poll Feed');
    assert.equal(pmStarts,1,'ordinary leadership preserves PM');
    assert.ok(settings>=1,'settings reporting continues for either leader');
    await leader.onRelease();
    leader.onAcquire();
    await new Promise(resolve=>setImmediate(resolve));
    await leader.onRelease();
    assert.deepEqual(feedDisabledWarnings, priority === 2 ? [] : [
      '[eigenflux] WARN Feed polling disabled: this Claude Code session is not channel-enabled; set EIGENFLUX_LEADER_PRIORITY=2 to override',
    ], 'an ordinary leader warns once per process that Feed polling is disabled');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
