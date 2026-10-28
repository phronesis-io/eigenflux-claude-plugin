import { execEigenflux, type CliResult, type ExecOptions } from './cli-executor.js';

type ExecFn = <T>(bin: string, args: string[], options?: ExecOptions) => Promise<CliResult<T>>;

export interface HeartbeatPlan {
  agent_prompt: string;
  wake_on_empty: boolean;
  cli_version?: string;
}

export type HeartbeatStartResult = HeartbeatPlan | null |
  { kind: 'auth_required' | 'auth_unavailable'; stderr: string } | { kind: 'not_installed' };

export class HeartbeatPlanRunner {
  private inFlight = false;

  constructor(
    private readonly eigenfluxBin: string,
    private readonly eigenfluxHome: string,
    private readonly serverName: string,
    private readonly exec: ExecFn = execEigenflux
  ) {}

  async run(): Promise<HeartbeatStartResult> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      const result = await this.exec<HeartbeatPlan>(
        this.eigenfluxBin,
        [
          '--homedir',
          this.eigenfluxHome,
          '--server',
          this.serverName,
          'heartbeat',
          'plan',
          '--format',
          'json',
        ],
        { timeout: 300_000 }
      );
      if (result.kind === 'success') {
        if (typeof result.data?.agent_prompt !== 'string' ||
            !result.data.agent_prompt.trim() ||
            typeof result.data.wake_on_empty !== 'boolean') {
          throw new Error('EigenFlux CLI returned no compatible central heartbeat plan');
        }
        return result.data;
      }
      const detail = result.kind === 'error' ? result.error.message
        : result.kind === 'auth_required' ? result.stderr : result.bin;
      console.error(`[eigenflux:heartbeat] plan skipped: ${result.kind}: ${detail}`);
      if (result.kind === 'not_installed') return { kind: 'not_installed' };
      if (result.kind === 'auth_required') return { kind: 'auth_required', stderr: result.stderr };
      if (result.kind === 'error' && result.authenticationUnavailable) {
        return { kind: 'auth_unavailable', stderr: result.stderr };
      }
      return null;
    } catch (error) {
      console.error(
        `[eigenflux:heartbeat] plan crashed: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    } finally {
      this.inFlight = false;
    }
  }
}
