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

export const CONFIG = {
  FEED_POLL_INTERVAL_SEC: parseInterval('EIGENFLUX_FEED_POLL_INTERVAL', 300),
  EIGENFLUX_BIN: process.env.EIGENFLUX_BIN || 'eigenflux',
  EIGENFLUX_SERVER: process.env.EIGENFLUX_SERVER || 'eigenflux',
  SKILL_VER,
} as const;
