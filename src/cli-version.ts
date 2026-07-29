/**
 * Installed-CLI version detection and comparison, for the one-time
 * cli_outdated channel event at startup.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import { execEigenflux, type CliResult, type ExecOptions } from './cli-executor.js';

export type ExecFn = <T>(bin: string, args: string[], options?: ExecOptions) => Promise<CliResult<T>>;

/**
 * Read the installed CLI version via `eigenflux version` (its JSON output
 * includes `cli_version`). Returns null when the CLI is missing or the
 * version is unreadable.
 */
export async function getInstalledCliVersion(
  eigenfluxBin: string,
  exec: ExecFn = execEigenflux
): Promise<string | null> {
  try {
    const result = await exec<{ cli_version?: string }>(eigenfluxBin, ['version']);
    if (result.kind === 'success' && typeof result.data?.cli_version === 'string') {
      return result.data.cli_version;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Semver-ish comparison (major.minor.patch). Unknown/unparseable input
 * returns false so we never nag on bad data.
 */
export function isCliOutdated(installed: string | null, target: string): boolean {
  if (!installed) return false;
  const parse = (v: string): number[] =>
    v.split('.').slice(0, 3).map((part) => parseInt(part, 10));
  const a = parse(installed);
  const b = parse(target);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x < y;
  }
  return false;
}
