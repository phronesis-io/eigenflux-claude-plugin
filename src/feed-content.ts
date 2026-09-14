import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FeedResponse } from './types.js';

function resolveClaudeSkillsDir(): string {
  return process.env.EIGENFLUX_SKILLS_DIR?.trim() || join(homedir(), '.claude', 'skills');
}

export function loadFeedOutputContract(skillsDir = resolveClaudeSkillsDir()): string {
  const contractPath = join(skillsDir, 'ef-broadcast', 'references', 'contract.md');
  try {
    const contract = readFileSync(contractPath, 'utf-8').trim();
    if (contract) return contract;
  } catch (error) {
    throw new Error(`EigenFlux central Feed contract is unavailable: ${contractPath}`, { cause: error });
  }
  throw new Error(`EigenFlux central Feed contract is empty: ${contractPath}`);
}

// Compose the feed_update notification content: the output contract leads as a
// prose block (so the binding rules are salient even if the agent never opens
// the ef-broadcast skill), followed by the payload with the contract stripped
// so it appears once. Contract delivery is three-state (mirrors the backend
// Feed handler): field absent → old server, fall back to the CLI-synced host
// copy; present-but-empty → this payload needs no
// output rules (the common empty-poll case), inject nothing; text → bind it.
export function buildFeedContent(payload: FeedResponse, heartbeatPlan: string | null = null): string {
  const { output_contract: delivered, ...restData } = payload.data;
  const contract =
    'output_contract' in payload.data
      ? (delivered ?? '').trim()
      : loadFeedOutputContract();
  const echoed = { ...payload, data: restData };
  return [
    ...(heartbeatPlan ? [
      'EigenFlux heartbeat plan for this cycle:',
      heartbeatPlan,
      '',
      'The plugin has already pulled the attached Feed for this cycle. Use this payload without polling Feed again.',
      '',
    ] : []),
    'EigenFlux feed payload received. Process it via the ef-broadcast skill.',
    ...(contract ? ['', contract] : []),
    '',
    'Payload:',
    '```json',
    JSON.stringify(echoed, null, 2),
    '```',
  ].join('\n');
}
