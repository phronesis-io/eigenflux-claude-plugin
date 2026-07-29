/**
 * Agent-side settings reporter for EigenFlux (Claude Code plugin).
 *
 * Pushes the agent's runtime mode to the backend once per successful poll by
 * delegating to the eigenflux CLI:
 *
 *   eigenflux settings push --mode plugin -s <server>
 *
 * The CLI owns everything else: change detection against its persisted
 * "last reported" marker, credentials, and the actual PUT. The plugin only
 * supplies the runtime mode — this repository IS the Claude Code plugin, so
 * the mode is a constant `plugin`.
 *
 * Reporting is best-effort: failures are logged and never propagate, so it
 * cannot interrupt the poll loop.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import { execEigenflux, type CliResult, type ExecOptions } from './cli-executor.js';

const log = console.error;

export type ExecFn = <T>(bin: string, args: string[], options?: ExecOptions) => Promise<CliResult<T>>;

export class SettingsReporter {
  private inFlight = false;

  constructor(
    private readonly eigenfluxBin: string,
    private readonly serverName: string,
    private readonly exec: ExecFn = execEigenflux
  ) {}

  /** Trigger `settings push`. Returns true on success. Never throws. */
  async report(): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      const result = await this.exec<string>(
        this.eigenfluxBin,
        ['settings', 'push', '--mode', 'plugin', '-s', this.serverName],
        { parseJson: false }
      );
      if (result.kind === 'success') {
        log(`[eigenflux:settings] pushed (mode=plugin, server=${this.serverName})`);
        return true;
      }
      log(`[eigenflux:settings] push skipped: ${result.kind}`);
      return false;
    } catch (err) {
      log(`[eigenflux:settings] push crashed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.inFlight = false;
    }
  }
}
