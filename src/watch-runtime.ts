import type { WatchEvent } from './watch-client.js';
import type { HeartbeatPlanRunner } from './heartbeat-plan-runner.js';

export function supportsWatch(version: string | null): boolean {
  const match = version?.match(/^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/);
  return !!match && Number(match[1]) >= 1;
}

type Client = { start(): void; stop(): Promise<void> };

/** Version selection owns exactly one stream consumer; old CLIs stay supported. */
export class StreamSupervisor {
  private active: Client | null = null;
  private generation = 0;
  private selecting: Promise<void> | null = null;
  private enabled = false;
  usingWatch = false;
  constructor(private readonly legacy: Client, private readonly watch: Client, private readonly getVersion: () => Promise<string | null>) {}

  async start(): Promise<void> {
    this.enabled = true;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.enabled || this.usingWatch) return;
    if (this.selecting) return this.selecting;
    const generation = this.generation;
    const task = (async () => {
      const version = await this.getVersion();
      if (!this.enabled || generation !== this.generation) return;
      const useWatch = supportsWatch(version);
      const next = useWatch ? this.watch : this.legacy;
      if (this.active === next) return;
      await this.active?.stop();
      if (!this.enabled || generation !== this.generation) return;
      this.active = next;
      this.usingWatch = useWatch;
      next.start();
    })();
    this.selecting = task.finally(() => { this.selecting = null; });
    return this.selecting;
  }

  async stop(): Promise<void> {
    this.enabled = false;
    this.usingWatch = false;
    this.generation++;
    await this.selecting;
    await this.active?.stop();
    this.active = null;
    this.usingWatch = false;
  }
}

/** Only routes central instructions; no business rules or extra timers. */
export class WatchEventRouter {
  private inFlight = new Map<string, Promise<void>>();
  private enabled = false;
  private deliveries = new Set<Promise<void>>();
  constructor(private readonly deps: {
    plans: Pick<HeartbeatPlanRunner, 'run' | 'cancelQueued'>;
    refreshProfile: () => Promise<void>;
    deliverPm: (event: WatchEvent) => Promise<void>;
    notify: (type: string, content: string) => Promise<void>;
  }) {}
  start(): void { this.enabled = true; }
  async stop(): Promise<void> {
    this.enabled = false;
    const plansStopped = this.deps.plans.cancelQueued();
    await Promise.allSettled([plansStopped, ...this.inFlight.values(), ...this.deliveries]);
  }
  private track(task: Promise<void>): Promise<void> {
    this.deliveries.add(task);
    return task.finally(() => { this.deliveries.delete(task); });
  }
  handle(event: WatchEvent): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const type = event.type;
    if (type === 'pm_push' || type === 'friend_accepted' || type === 'friend_rejected') return this.track(this.deps.deliverPm(event));
    if (type === 'diagnostic') return this.track(this.deps.notify('watch_diagnostic', JSON.stringify(event)));
    const pending = this.inFlight.get(type);
    if (pending) return pending;
    const task = (async () => {
      if (type === 'profile_review_due') await this.deps.refreshProfile();
      if (type === 'control_pending' || type === 'maintenance_due') {
        const plan = await this.deps.plans.run(type === 'control_pending' ? 'control' : 'maintenance');
        if (this.enabled && plan?.agent_prompt.trim()) await this.deps.notify(type === 'control_pending' ? 'control_plan' : 'maintenance_plan', plan.agent_prompt);
      }
    })();
    this.inFlight.set(type, task);
    return task.finally(() => { this.inFlight.delete(type); });
  }
}
