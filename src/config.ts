import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Single source of truth for the plugin version at runtime. Kept in sync with
// package.json and .claude-plugin/plugin.json by scripts/set-version.mjs.
const PLUGIN_VERSION = '0.0.10';

// Minimum eigenflux CLI version this plugin build expects. When the installed
// CLI is older, the channel emits a cli_outdated event so the agent can guide
// the user through an upgrade (new subcommands silently fail on older CLIs
// otherwise). 0.0.34 is the first release shipping `heartbeat plan`.
const EXPECTED_CLI_VERSION = '0.0.34';

// Poll interval: the CLI config key `feed_poll_interval` is the runtime source
// (read fresh before each scheduling, same as the OpenClaw plugin). The env var
// is an explicit override that wins when set; DEFAULT applies when the CLI has
// no value or is unreachable.
export const DEFAULT_POLL_INTERVAL_SEC = 600;
export const MIN_POLL_INTERVAL_SEC = 10;
export const MAX_POLL_INTERVAL_SEC = 24 * 60 * 60;

function parseIntervalOverride(envKey: string): number | null {
  const raw = process.env[envKey];
  if (!raw) return null;
  const seconds = parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function resolveEigenfluxHome(): string {
  const envHome = process.env.EIGENFLUX_HOME;
  if (envHome) {
    const expanded = envHome === '~' ? os.homedir() : envHome.startsWith('~/') ? path.join(os.homedir(), envHome.slice(2)) : envHome;
    return expanded.endsWith('.eigenflux') ? expanded : path.join(expanded, '.eigenflux');
  }
  return path.join(os.homedir(), '.eigenflux');
}

// Set once at module load so all CLI child processes inherit it.
process.env.EIGENFLUX_HOME = resolveEigenfluxHome();
if (!process.env.EIGENFLUX_HOST) {
  process.env.EIGENFLUX_HOST = `claude-code/${PLUGIN_VERSION}`;
}
if (!process.env.EIGENFLUX_CHANNEL) {
  process.env.EIGENFLUX_CHANNEL = 'claude-code';
}
// Model identity (X-Client-Model header on every CLI request, persisted by the
// backend off the heartbeat feed pull). Deterministic best-effort: ANTHROPIC_MODEL
// env first, then the configured default in ~/.claude/settings.json. Unresolvable
// leaves the env unset — an absent header never clobbers the backend's last value.
function resolveClaudeModel(): string {
  const envModel = process.env.ANTHROPIC_MODEL?.trim();
  if (envModel) return envModel;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
    const model = JSON.parse(raw).model;
    if (typeof model === 'string' && model.trim()) return model.trim();
  } catch {
    // no settings file or unparsable — fall through
  }
  return '';
}
if (!process.env.EIGENFLUX_MODEL) {
  const model = resolveClaudeModel();
  if (model) process.env.EIGENFLUX_MODEL = model;
}

export const CONFIG = {
  // null = no env override → read the CLI config dynamically each cycle.
  FEED_POLL_INTERVAL_OVERRIDE_SEC: parseIntervalOverride('EIGENFLUX_FEED_POLL_INTERVAL'),
  EIGENFLUX_BIN: process.env.EIGENFLUX_BIN || 'eigenflux',
  EIGENFLUX_SERVER: process.env.EIGENFLUX_SERVER || 'eigenflux',
  EIGENFLUX_HOME: process.env.EIGENFLUX_HOME as string,
  PLUGIN_VERSION,
  EXPECTED_CLI_VERSION,
  // Legacy alias: the skill bundle rides the plugin version.
  SKILL_VER: PLUGIN_VERSION,
} as const;
