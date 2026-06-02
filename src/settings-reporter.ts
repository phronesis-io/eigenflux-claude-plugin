/**
 * Agent-side settings reporter for EigenFlux.
 *
 * Pushes the agent's local runtime mode to the backend on every heartbeat by
 * delegating to the eigenflux CLI:
 *
 *   eigenflux settings push --mode <plugin|skill> -s <server>
 *
 * The CLI owns everything else: it reads feed_delivery_preference from its
 * config, compares against the "last reported" marker it persists, only issues
 * the PUT /api/v1/agents/me/settings when something actually changed, and uses
 * its own credentials/base-URL. The plugin therefore stays thin — it only
 * supplies the runtime `mode` (which is only knowable at runtime) and triggers
 * the CLI once per poll cycle.
 *
 * Reporting is best-effort: any CLI failure is logged at warn/debug level and
 * never propagates, so it cannot interrupt the heartbeat/poll loop.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import { execEigenflux, type CliResult } from './cli-executor.js';

const log = console.error;

export type AgentMode = 'plugin' | 'skill';

/** Injectable exec function so tests can supply a fake without module mocking. */
export type ExecFn = <T>(
  bin: string,
  args: string[],
) => Promise<CliResult<T>>;

export interface SettingsReporterConfig {
  serverName: string;
  eigenfluxBin: string;
  /** Injectable mode resolver for tests; defaults to env-based detection. */
  resolveMode?: () => AgentMode | undefined;
  /** Injectable CLI runner for tests; defaults to the real execEigenflux. */
  exec?: ExecFn;
}

/**
 * Determine the agent runtime mode from environment signals set at plugin
 * startup (see config.ts):
 *   - EIGENFLUX_HOST    = "claude-code/<version>" for this Claude Code runtime.
 *   - EIGENFLUX_CHANNEL = "claude-code" (default) for this Claude Code runtime.
 *
 * This repository IS the Claude Code plugin, so the host/channel signals
 * unambiguously identify it as "plugin" mode (analogous to the OpenClaw
 * plugin's openclaw -> plugin mapping). We inspect EIGENFLUX_CHANNEL first so
 * explicit "plugin"/"skill" channels map correctly. When no usable signal is
 * available we return undefined and the caller omits the `--mode` flag rather
 * than guessing (the CLI then leaves mode untouched).
 */
export function resolveAgentMode(env: NodeJS.ProcessEnv = process.env): AgentMode | undefined {
  const channel = env.EIGENFLUX_CHANNEL?.trim().toLowerCase();
  if (channel === 'skill') {
    return 'skill';
  }
  if (channel === 'plugin') {
    return 'plugin';
  }

  const host = env.EIGENFLUX_HOST?.trim().toLowerCase();
  // host looks like "claude-code/0.0.5" — the Claude Code plugin runtime.
  if (host && host.startsWith('claude-code')) {
    return 'plugin';
  }
  // The default Claude Code channel maps to plugin; unknown channels stay
  // ambiguous so we omit --mode rather than guess.
  if (channel === 'claude-code') {
    return 'plugin';
  }

  return undefined;
}

/**
 * Triggers the eigenflux CLI to push the agent's settings to the backend.
 * Change-detection and dedup live in the CLI; this class just resolves the
 * runtime mode and spawns the command once per heartbeat, best-effort.
 */
export class SettingsReporter {
  private readonly config: SettingsReporterConfig;
  private readonly resolveMode: () => AgentMode | undefined;
  private readonly exec: ExecFn;
  private inFlight = false;

  constructor(config: SettingsReporterConfig) {
    this.config = config;
    this.resolveMode = config.resolveMode ?? (() => resolveAgentMode());
    this.exec = config.exec ?? execEigenflux;
  }

  /**
   * Invoke `eigenflux settings push` for the configured server. Returns true if
   * the CLI ran successfully, false if it was skipped (in flight) or failed.
   * Never throws.
   */
  async report(): Promise<boolean> {
    if (this.inFlight) {
      log(`[eigenflux:settings] Push skipped (in flight) for server=${this.config.serverName}`);
      return false;
    }

    this.inFlight = true;
    try {
      const args = ['settings', 'push', '-s', this.config.serverName];

      const mode = this.resolveMode();
      if (mode) {
        // Insert --mode <mode> after the subcommand ("settings push").
        args.splice(2, 0, '--mode', mode);
      } else {
        log(
          `[eigenflux:settings] Mode signal unavailable for server=${this.config.serverName}; omitting --mode`,
        );
      }

      const result = await this.exec<unknown>(this.config.eigenfluxBin, args);

      if (result.kind === 'success') {
        log(
          `[eigenflux:settings] Pushed agent settings for server=${this.config.serverName} (mode=${mode ?? 'omitted'})`,
        );
        return true;
      }

      if (result.kind === 'auth_required') {
        log(`[eigenflux:settings] Push: auth required for server=${this.config.serverName}`);
        return false;
      }

      // kind === 'error'
      log(
        `[eigenflux:settings] Push failed for server=${this.config.serverName}: ${result.error.message}`,
      );
      return false;
    } catch (err) {
      // Best-effort: never interrupt the heartbeat. Log and move on.
      log(
        `[eigenflux:settings] Push crashed for server=${this.config.serverName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      this.inFlight = false;
    }
  }
}
