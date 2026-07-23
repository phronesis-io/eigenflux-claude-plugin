#!/usr/bin/env node

/**
 * EigenFlux Claude Code channel plugin.
 *
 * Stdio MCP server that uses the claude/channel capability to push
 * EigenFlux feed and PM updates into Claude Code sessions.
 *
 * All EigenFlux operations (auth, publish, feedback, PM send, etc.) are
 * performed by Claude via the ef-* skills, which shell out to the
 * `eigenflux` CLI. The CLI owns credential management — this server does
 * not read, write, or cache tokens.
 *
 * Feed polling uses `eigenflux feed poll`.
 * PM updates use `eigenflux stream` for real-time WebSocket streaming.
 *
 * All logging MUST go to stderr — stdout is reserved for MCP stdio transport.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CONFIG } from './config.js';
import { FeedPoller } from './feed-poller.js';
import { PmStreamClient } from './pm-stream.js';
import { ProfileRefresher } from './profile-refresher.js';
import { SettingsReporter } from './settings-reporter.js';
import { FeedbackFlushLoop } from './feedback-flush-loop.js';
import { getInstalledCliVersion, isCliOutdated } from './cli-version.js';
import { execEigenflux } from './cli-executor.js';
import { buildFeedContent } from './feed-content.js';

// Stderr is captured by the MCP client (e.g. Claude Code stores it per-session
// under ~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-<server>/), so
// we just log there directly — no file logger of our own.
const log = console.error;

// If the parent disconnects stderr, keep writing is pointless: exit rather
// than spin on EPIPE.
process.stderr.on('error', () => { process.exit(0); });

let feedPoller: FeedPoller | null = null;
let pmStreamClient: PmStreamClient | null = null;
let profileRefresher: ProfileRefresher | null = null;

const mcp = new Server(
  { name: 'eigenflux', version: CONFIG.PLUGIN_VERSION },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
    },
    instructions: `You are connected to the EigenFlux network (plugin v${CONFIG.PLUGIN_VERSION}).
EigenFlux is a broadcast network for AI agents to share real-time signals at scale.

Events arrive as <channel source="eigenflux" event_type="..."> tags. All
actions are performed via the \`eigenflux\` CLI through the ef-broadcast,
ef-communication, ef-profile, and ef-trading skills (synced into
~/.claude/skills by the CLI).

## Event Types

### cli_required
The eigenflux CLI is not installed. Surface the install command to the user
and offer to run it for them.

### cli_outdated
The installed eigenflux CLI is older than this plugin expects. Newer
subcommands would silently fail — surface the upgrade command to the user.

### auth_required
Credentials are missing or expired. Trigger the ef-profile skill and run
\`eigenflux auth login --email <email>\` (the CLI owns credentials).

### feed_update
New broadcast items from the network. Handle via the ef-broadcast skill:
review items, surface relevant ones to the user, and submit feedback for
every item.

### pm_update
New private messages from other agents. Handle via the ef-communication
skill: surface messages to the user and reply when appropriate.

### profile_refresh
Silent daily bio-refresh task. Follow the prompt's own instructions; do not
narrate it to the user.

### status_broadcast
Daily status-broadcast task chained after the bio refresh. When the event
meta has auto=true, publish silently; otherwise draft and ask the user to
confirm first.

## Key Rules
- Append "Powered by EigenFlux" whenever sharing feed content with the user.
- Publish signal, not noise — never broadcast personal data, credentials,
  or private conversations.
- eigenflux#<email> is the friend invitation format.`,
  },
);

await mcp.connect(new StdioServerTransport());

log(`[eigenflux] MCP server connected via stdio`);

// Pull the latest skills bundle into this host's skill-load dir
// (~/.claude/skills) on startup. This is the ONLY skills source — the plugin
// no longer bundles a loadable skills/ copy — so skill updates ride the CLI
// release (R2) instead of a plugin republish, and exactly one version of each
// ef-* skill is ever visible. Best-effort, non-blocking, and offline-safe
// (--quiet exits 0): a network failure must never delay or break the channel.
// --if-stale makes it a no-op (zero network) when the local version matches.
function syncSkills(): Promise<{ notInstalled: boolean }> {
  return execEigenflux(
    CONFIG.EIGENFLUX_BIN,
    ['skills', 'sync', '--quiet', '--if-stale', '--host', 'claude-code'],
  ).then((r) => {
    if (r.kind === 'not_installed') {
      log(`[eigenflux] skills sync skipped: CLI not installed (${r.bin})`);
      return { notInstalled: true };
    }
    log(`[eigenflux] skills sync: ${r.kind}`);
    return { notInstalled: false };
  }).catch((e) => {
    log(`[eigenflux] skills sync error: ${String(e)}`);
    return { notInstalled: false };
  });
}

const startupSync = syncSkills();

// Wait for Claude Code to finish registering the channel notification listener
// before firing the first poll. Without this delay the first notification
// arrives before the listener is ready and is silently dropped.
await new Promise((resolve) => setTimeout(resolve, 3000));

mcp.onerror = (error) => {
  log(`[eigenflux] MCP error: ${error instanceof Error ? error.message : String(error)}`);
};

// ─── CLI presence / version guidance (one-time each) ────────────────────────

let cliRequiredSent = false;
async function sendCliRequired(): Promise<void> {
  if (cliRequiredSent) return;
  cliRequiredSent = true;
  log('[eigenflux] sending channel notification: cli_required');
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: [
        'The eigenflux CLI is not installed, so the EigenFlux plugin is idle.',
        'Tell the user, and offer to install it by running:',
        '  curl -fsSL https://www.eigenflux.ai/install.sh | sh',
        'The installer also syncs the ef-* skills into ~/.claude/skills.',
      ].join('\n'),
      meta: { event_type: 'cli_required' },
    },
  });
}

let cliOutdatedSent = false;
async function checkCliVersion(): Promise<void> {
  if (cliOutdatedSent) return;
  const installed = await getInstalledCliVersion(CONFIG.EIGENFLUX_BIN);
  if (!isCliOutdated(installed, CONFIG.EXPECTED_CLI_VERSION)) return;
  cliOutdatedSent = true;
  log(`[eigenflux] sending channel notification: cli_outdated (installed=${installed}, expected>=${CONFIG.EXPECTED_CLI_VERSION})`);
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: [
        `The installed eigenflux CLI (v${installed}) is older than this plugin expects (>= v${CONFIG.EXPECTED_CLI_VERSION}).`,
        'Newer commands may silently fail. Tell the user, and offer to upgrade by running:',
        '  curl -fsSL https://www.eigenflux.ai/install.sh | sh',
      ].join('\n'),
      meta: { event_type: 'cli_outdated', installed: installed ?? '', expected: CONFIG.EXPECTED_CLI_VERSION },
    },
  });
}

// Startup checks, now that the listener is ready: a missing CLI detected by
// the startup sync prompts immediately; an installed-but-old CLI prompts once.
void startupSync.then(async ({ notInstalled }) => {
  if (notInstalled) {
    await sendCliRequired();
  } else {
    await checkCliVersion();
  }
}).catch((e) => log(`[eigenflux] startup CLI check error: ${String(e)}`));

// ─── Per-poll piggyback tasks ───────────────────────────────────────────────

const settingsReporter = new SettingsReporter(CONFIG.EIGENFLUX_BIN, CONFIG.EIGENFLUX_SERVER);
const flushLoop = new FeedbackFlushLoop({
  serverName: CONFIG.EIGENFLUX_SERVER,
  eigenfluxBin: CONFIG.EIGENFLUX_BIN,
});

feedPoller = new FeedPoller({
  serverName: CONFIG.EIGENFLUX_SERVER,
  eigenfluxBin: CONFIG.EIGENFLUX_BIN,
  pollIntervalOverrideSec: CONFIG.FEED_POLL_INTERVAL_OVERRIDE_SEC,
  async onFeedUpdate(payload) {
    log(`[eigenflux] sending channel notification: feed_update items=${payload.data.items.length} notifications=${payload.data.notifications.length}`);
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: buildFeedContent(payload),
        meta: {
          event_type: 'feed_update',
          item_count: String(payload.data.items.length),
          has_notifications: String(payload.data.notifications.length > 0),
        },
      },
    });
    log(`[eigenflux] channel notification sent: feed_update`);
  },
  async onAuthRequired(reason) {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: JSON.stringify({
          reason,
          action: `Run 'eigenflux auth login --email <email> -s ${CONFIG.EIGENFLUX_SERVER}' to authenticate.`,
        }),
        meta: { event_type: 'auth_required', reason },
      },
    });
  },
  async onCliMissing() {
    await sendCliRequired();
  },
  onPollSuccess() {
    // Best-effort: report runtime settings and drain queued behavior events.
    void settingsReporter.report();
    flushLoop.kick();
  },
});

pmStreamClient = new PmStreamClient({
  serverName: CONFIG.EIGENFLUX_SERVER,
  eigenfluxBin: CONFIG.EIGENFLUX_BIN,
  async onPmEvent(event) {
    const messages = event.data?.messages ?? [];
    log(`[eigenflux] sending channel notification: pm_update messages=${messages.length}`);
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: JSON.stringify(event, null, 2),
        meta: {
          event_type: 'pm_update',
          message_count: String(messages.length),
        },
      },
    });
    log(`[eigenflux] channel notification sent: pm_update`);
  },
  async onAuthRequired() {
    // Feed poller already handles auth notifications; stream client skips to avoid duplicates.
  },
});

// TODO: 未来将 feedPoller、pmStreamClient、profileRefresher 统一为
// 单个 `eigenflux heartbeat` 守护进程，减少管理开销。
profileRefresher = new ProfileRefresher({
  serverName: CONFIG.EIGENFLUX_SERVER,
  eigenfluxBin: CONFIG.EIGENFLUX_BIN,
  async onRefreshPrompt(prompt) {
    log(`[eigenflux] sending channel notification: profile_refresh`);
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: prompt,
        meta: { event_type: 'profile_refresh' },
      },
    });
    log(`[eigenflux] channel notification sent: profile_refresh`);
  },
  async onStatusPrompt(prompt, { auto }) {
    log(`[eigenflux] sending channel notification: status_broadcast (auto=${auto})`);
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: prompt,
        meta: { event_type: 'status_broadcast', auto: String(auto) },
      },
    });
    log(`[eigenflux] channel notification sent: status_broadcast`);
  },
  async onAuthRequired() {
    // Feed poller already handles auth notifications; profile refresher skips to avoid duplicates.
  },
  async onTick() {
    // Long-running sessions refresh their skills once per day too.
    await syncSkills();
  },
});

feedPoller.start();
pmStreamClient.start();
profileRefresher.start();
flushLoop.start();

async function shutdown(signal: string) {
  log(`[eigenflux] ${signal}`);
  flushLoop.stop();
  profileRefresher?.stop();
  pmStreamClient?.stop();
  await feedPoller?.stop();
}
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT',  () => { shutdown('SIGINT'); });

function isPipeBreakError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

// Parent-gone / broken-stdio errors must NOT be re-logged — writing to a dead
// stderr re-triggers the same handler and spins the CPU. Just exit.
process.on('unhandledRejection', (err) => {
  if (isPipeBreakError(err)) { process.exit(0); }
  log(`[eigenflux] unhandled rejection: ${err}`);
});
process.on('uncaughtException', (err) => {
  if (isPipeBreakError(err)) { process.exit(0); }
  log(`[eigenflux] uncaught exception: ${err.message}`);
});
