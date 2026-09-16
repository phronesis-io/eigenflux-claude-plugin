import { execEigenflux, type CliResult, type ExecOptions } from './cli-executor.js';

type ExecFn = <T>(bin: string, args: string[], options?: ExecOptions) => Promise<CliResult<T>>;

export interface HeartbeatPlan {
  agent_prompt: string;
  wake_on_empty: boolean;
}

export type HeartbeatPlanMode = 'full' | 'control' | 'maintenance';

export class HeartbeatPlanRunner {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<HeartbeatPlan | null>>();
  private inFlight = false;

  constructor(
    private readonly eigenfluxBin: string,
    private readonly eigenfluxHome: string,
    private readonly serverName: string,
    private readonly exec: ExecFn = execEigenflux
  ) {}

  run(mode: HeartbeatPlanMode = 'full', options: { watchManaged?: boolean } = {}): Promise<HeartbeatPlan | null> {
    const watchManaged = mode === 'full' && options.watchManaged === true;
    const key = `${mode}:${watchManaged}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const task = this.queue.then(() => this.runOnce(mode, watchManaged));
    this.pending.set(key, task);
    this.queue = task.catch(() => {}).finally(() => { this.pending.delete(key); });
    return task;
  }

  private async runOnce(mode: HeartbeatPlanMode, watchManaged: boolean): Promise<HeartbeatPlan | null> {
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
          ...(mode === 'full' ? [] : [`--${mode}-only`]),
          ...(watchManaged ? ['--watch-managed'] : []),
          '--format',
          'json',
        ],
        // Allow two CLI update attempts plus Skills sync and rollback time.
        { timeout: 300_000 }
      );
      if (result.kind === 'success') {
        if (typeof result.data?.agent_prompt !== 'string' ||
            (mode === 'full' && !result.data.agent_prompt.trim()) ||
            typeof result.data.wake_on_empty !== 'boolean') {
          throw new Error('EigenFlux CLI returned no compatible central heartbeat plan');
        }
        return result.data;
      }
      const detail = result.kind === 'error' ? result.error.message
        : result.kind === 'auth_required' ? result.stderr : result.bin;
      console.error(`[eigenflux:heartbeat] plan skipped: ${result.kind}: ${detail}`);
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
