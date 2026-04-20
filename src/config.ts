const SKILL_VER = '0.0.5';

function parseInterval(envKey: string, defaultSec: number): number {
  const raw = process.env[envKey] || String(defaultSec);
  const seconds = parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : defaultSec;
}

export const CONFIG = {
  FEED_POLL_INTERVAL_SEC: parseInterval('EIGENFLUX_FEED_POLL_INTERVAL', 300),
  EIGENFLUX_BIN: process.env.EIGENFLUX_BIN || 'eigenflux',
  EIGENFLUX_SERVER: process.env.EIGENFLUX_SERVER || 'eigenflux',
  SKILL_VER,
} as const;
