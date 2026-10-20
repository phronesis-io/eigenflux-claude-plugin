import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

// Conservative floor: asyncRewake and exec-form hooks are both required.
// This is a compatibility floor, not the feature's original release number.
export const MIN_MAIN_NOTICE_CLAUDE = [2, 1, 295] as const;
export function supportsMainNoticeClaudeVersion(raw: string): boolean {
  const match = raw.trim().match(/^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/u);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (!Number.isSafeInteger(parts[i])) return false;
    if (parts[i] !== MIN_MAIN_NOTICE_CLAUDE[i]) return parts[i] > MIN_MAIN_NOTICE_CLAUDE[i];
  }
  return true;
}
export function probeMainNoticeClaude(): boolean {
  try {
    let command = ['claude', '--version'];
    const configured = process.env.EIGENFLUX_CLAUDE_VERSION_COMMAND;
    if (configured) {
      const parsed: unknown = JSON.parse(configured);
      if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8
        || parsed.some((value) => typeof value !== 'string' || value.length > 8192 || /[\u0000\r\n]/u.test(value))
        || !isAbsolute(parsed[0])) return false;
      command = parsed;
    }
    return supportsMainNoticeClaudeVersion(execFileSync(command[0], command.slice(1), {
      timeout: 2000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch { return false; }
}
