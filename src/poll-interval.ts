/**
 * Dynamic feed poll interval, read from the CLI config before each scheduling
 * (`eigenflux config get --key feed_poll_interval`). Mirrors the OpenClaw
 * plugin so the dashboard/CLI setting takes effect on every host. Values are
 * seconds; anything non-numeric, missing, or out of range falls back to the
 * default.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import { execEigenflux, type CliResult } from './cli-executor.js';
import {
  DEFAULT_POLL_INTERVAL_SEC,
  MIN_POLL_INTERVAL_SEC,
  MAX_POLL_INTERVAL_SEC,
} from './config.js';

const log = console.error;

export const POLL_INTERVAL_CONFIG_KEY = 'feed_poll_interval';

export type ExecFn = <T>(bin: string, args: string[]) => Promise<CliResult<T>>;

export async function readPollIntervalSec(
  eigenfluxBin: string,
  serverName: string,
  exec: ExecFn = execEigenflux
): Promise<number> {
  let result: CliResult<unknown>;
  try {
    result = await exec<unknown>(eigenfluxBin, [
      'config', 'get', '--key', POLL_INTERVAL_CONFIG_KEY, '-s', serverName, '-f', 'json',
    ]);
  } catch {
    return DEFAULT_POLL_INTERVAL_SEC;
  }

  if (result.kind !== 'success' || result.data === undefined || result.data === null) {
    return DEFAULT_POLL_INTERVAL_SEC;
  }

  let numeric: number | undefined;
  if (typeof result.data === 'number' && Number.isFinite(result.data)) {
    numeric = result.data;
  } else if (typeof result.data === 'string') {
    const parsed = Number(result.data.trim());
    if (Number.isFinite(parsed)) numeric = parsed;
  }

  if (numeric === undefined) {
    log(`[eigenflux:feed] Ignoring non-numeric ${POLL_INTERVAL_CONFIG_KEY} (value=${JSON.stringify(result.data)}); using ${DEFAULT_POLL_INTERVAL_SEC}s`);
    return DEFAULT_POLL_INTERVAL_SEC;
  }

  const floored = Math.floor(numeric);
  if (floored < MIN_POLL_INTERVAL_SEC || floored > MAX_POLL_INTERVAL_SEC) {
    log(`[eigenflux:feed] ${POLL_INTERVAL_CONFIG_KEY}=${floored}s outside [${MIN_POLL_INTERVAL_SEC}, ${MAX_POLL_INTERVAL_SEC}]; using ${DEFAULT_POLL_INTERVAL_SEC}s`);
    return DEFAULT_POLL_INTERVAL_SEC;
  }

  return floored;
}
