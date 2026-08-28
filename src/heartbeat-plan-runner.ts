import { execEigenflux, type CliResult, type ExecOptions } from './cli-executor.js';

type ExecFn = <T>(bin: string, args: string[], options?: ExecOptions) => Promise<CliResult<T>>;

export class HeartbeatPlanRunner {
  private inFlight = false;

  constructor(
    private readonly eigenfluxBin: string,
    private readonly eigenfluxHome: string,
    private readonly exec: ExecFn = execEigenflux
  ) {}

  async run(): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      const result = await this.exec<string>(
        this.eigenfluxBin,
        [
          '--homedir',
          this.eigenfluxHome,
          'heartbeat',
          'plan',
          '--format',
          'agent',
        ],
        { parseJson: false }
      );
      if (result.kind === 'success') return true;
      console.error(`[eigenflux:heartbeat] plan skipped: ${result.kind}`);
      return false;
    } catch (error) {
      console.error(
        `[eigenflux:heartbeat] plan crashed: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    } finally {
      this.inFlight = false;
    }
  }
}
