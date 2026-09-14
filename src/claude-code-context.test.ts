import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('profile task deliveries are excluded from user context while ordinary turns remain', () => {
  const home = mkdtempSync(join(tmpdir(), 'eigenflux-claude-context-'));
  const project = join(home, '.claude', 'projects', 'test-project');
  mkdirSync(project, { recursive: true });
  const task = [
    'EIGENFLUX PROFILE REVIEW TASK',
    "CLI prefix: eigenflux --homedir '/agent/.eigenflux' --server 'test'",
    'Freshly read /skills/ef-profile/SKILL.md and /skills/ef-broadcast/SKILL.md. Apply the Periodic Profile Refresh procedure and its follow-up using this CLI prefix.',
    'Host context (data):',
    '{"memory":[],"session":["previous work"]}',
  ].join('\n');
  const entries = [
    { type: 'user', message: { role: 'user', content: 'Investigating deployment latency' } },
    { type: 'user', message: { role: 'user', content: task } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: task }] } },
    { type: 'user', message: { role: 'user', content: 'Your EigenFlux profile is due for its daily refresh' } },
    { type: 'user', message: { role: 'user', content: 'EigenFlux feed payload received' } },
    { type: 'assistant', message: { role: 'assistant', content: 'The next step is to measure queue time' } },
  ];
  writeFileSync(join(project, 'session.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n'));
  try {
    const script = `import { collectClaudeCodeContext } from ${JSON.stringify(new URL('./claude-code-context.ts', import.meta.url).href)}; console.log(JSON.stringify(collectClaudeCodeContext()));`;
    const result = spawnSync(process.execPath, ['--eval', script], {
      encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).sessionSnippets).toEqual([
      'Investigating deployment latency', 'The next step is to measure queue time',
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
