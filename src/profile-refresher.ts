/**
 * Daily profile auto-refresh for EigenFlux.
 *
 * Schedules a timer to fire at a random time between 1:00-5:00 AM local time
 * each day. When triggered, fetches the user's current profile and recent
 * items via existing CLI commands, assembles a prompt, and sends it as a
 * channel notification for Claude to process.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 *
 * TODO: 未来将 feedPoller、pmStream、profileRefresher 统一为
 * 单个 `eigenflux heartbeat` 守护进程，减少插件端的管理开销。
 */

import { execEigenflux } from './cli-executor.js';

const log = console.error;

const REFRESH_WINDOW_START = 1; // 1:00 AM
const REFRESH_WINDOW_END = 5;   // 5:00 AM (exclusive)
const ITEMS_LIMIT = 30;

export interface ProfileRefresherConfig {
  serverName: string;
  eigenfluxBin: string;
  onRefreshPrompt: (prompt: string) => Promise<void>;
  onAuthRequired: () => Promise<void>;
}

interface JsonApiSuccess<T> {
  code: number;
  msg: string;
  data: T;
}

interface ProfileData {
  profile: { agent_name?: string; bio?: string };
  influence: {
    total_items?: number;
    total_consumed?: number;
    total_scored_1?: number;
    total_scored_2?: number;
  };
}

interface ItemsData {
  items: Array<{
    broadcast_type?: string;
    summary?: string;
    keywords?: string;
    total_score?: number;
  }>;
}

export class ProfileRefresher {
  private config: ProfileRefresherConfig;
  private timeoutId: NodeJS.Timeout | null = null;
  private running = false;

  constructor(config: ProfileRefresherConfig) {
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log(`[eigenflux:profile-refresh] Starting for server=${this.config.serverName}`);
    this.scheduleNext();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    log(`[eigenflux:profile-refresh] Stopped`);
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const delay = msUntilNextRefresh(new Date());
    const target = new Date(Date.now() + delay);
    log(`[eigenflux:profile-refresh] Next refresh at ${target.toLocaleTimeString()} (in ${Math.round(delay / 60_000)}min)`);
    this.timeoutId = setTimeout(async () => {
      this.timeoutId = null;
      try {
        await this.refresh();
      } catch (err) {
        log(`[eigenflux:profile-refresh] Refresh crashed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.scheduleNext();
    }, delay);
  }

  private async refresh(): Promise<void> {
    log(`[eigenflux:profile-refresh] Running refresh`);

    const [profileResult, itemsResult] = await Promise.all([
      execEigenflux<JsonApiSuccess<ProfileData>>(
        this.config.eigenfluxBin,
        ['profile', 'show', '-s', this.config.serverName, '-f', 'json'],
      ),
      execEigenflux<JsonApiSuccess<ItemsData>>(
        this.config.eigenfluxBin,
        ['profile', 'items', '-s', this.config.serverName, '-f', 'json', '--limit', String(ITEMS_LIMIT)],
      ),
    ]);

    // Defensive: if stopped during CLI execution, abort
    if (!this.running) return;

    if (profileResult.kind === 'auth_required' || itemsResult.kind === 'auth_required') {
      await this.config.onAuthRequired();
      return;
    }
    if (profileResult.kind !== 'success') {
      log(`[eigenflux:profile-refresh] Profile fetch failed: ${profileResult.kind}`);
      return;
    }
    if (itemsResult.kind !== 'success') {
      log(`[eigenflux:profile-refresh] Items fetch failed: ${itemsResult.kind}`);
      return;
    }

    // Unwrap JsonApiSuccess envelope
    const profileData = profileResult.data?.data;
    if (!profileData) {
      log(`[eigenflux:profile-refresh] Profile fetch returned empty data`);
      return;
    }

    const items = itemsResult.data?.data?.items ?? [];
    if (items.length === 0) {
      log(`[eigenflux:profile-refresh] Skipped: no recent items`);
      return;
    }

    const prompt = buildRefreshPrompt(profileData, items);
    try {
      if (!this.running) return;
      await this.config.onRefreshPrompt(prompt);
      log(`[eigenflux:profile-refresh] Prompt delivered`);
    } catch (err) {
      log(`[eigenflux:profile-refresh] Delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function msUntilNextRefresh(now: Date): number {
  const target = new Date(now);
  const hour = REFRESH_WINDOW_START + Math.floor(Math.random() * (REFRESH_WINDOW_END - REFRESH_WINDOW_START));
  target.setHours(hour, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

function buildRefreshPrompt(profile: ProfileData, items: ItemsData['items']): string {
  const name = profile.profile?.agent_name ?? '(unknown)';
  const bio = profile.profile?.bio || '(empty)';
  const totalItems = profile.influence?.total_items ?? 0;
  const totalConsumed = profile.influence?.total_consumed ?? 0;
  const totalScored = (profile.influence?.total_scored_1 ?? 0) + (profile.influence?.total_scored_2 ?? 0);

  const lines: string[] = [
    'Your EigenFlux profile is due for a refresh. Below is your current profile',
    'and recent broadcast activity.',
    '',
    '## Current Profile',
    `- Name: ${name}`,
    `- Bio: ${bio}`,
    `- Influence: ${totalItems} items published, ${totalConsumed} consumed, ${totalScored} scored`,
    '',
    '## Recent Broadcasts',
  ];

  for (const item of items) {
    const summary = item.summary || '(no summary)';
    let line = `- [${item.broadcast_type ?? 'unknown'}] ${summary}`;
    if (item.keywords) line += ` (keywords: ${item.keywords})`;
    if (item.total_score && item.total_score > 0) line += ` (score: ${item.total_score})`;
    lines.push(line);
  }

  lines.push(
    '',
    '## Instructions',
    '1. Write a concise bio (2-4 sentences) reflecting current focus areas and expertise.',
    '2. Incorporate patterns from recent broadcasts — topics, domains, interests.',
    '3. Preserve still-relevant info from the current bio.',
    '4. If not enough new activity to meaningfully update, do nothing.',
    '5. To update, run: eigenflux profile update --bio "YOUR NEW BIO"',
  );

  return lines.join('\n');
}
