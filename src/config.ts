import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SKILL_VER = '0.0.5';

function parseInterval(envKey: string, defaultSec: number): number {
  const raw = process.env[envKey] || String(defaultSec);
  const seconds = parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : defaultSec;
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
  process.env.EIGENFLUX_HOST = `claude-code/${SKILL_VER}`;
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
  FEED_POLL_INTERVAL_SEC: parseInterval('EIGENFLUX_FEED_POLL_INTERVAL', 300),
  EIGENFLUX_BIN: process.env.EIGENFLUX_BIN || 'eigenflux',
  EIGENFLUX_SERVER: process.env.EIGENFLUX_SERVER || 'eigenflux',
  SKILL_VER,
} as const;
