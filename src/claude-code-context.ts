/**
 * Claude Code host context for the daily profile refresh.
 *
 * Resolves the host-specific inputs the CLI's host-agnostic prompt cores
 * (`profile refresh-prompt` / `status-prompt`) need:
 *   - memory dirs: markdown the CLI reads directly (`--memory-dir`), i.e.
 *     ~/.claude (CLAUDE.md) and the most recently active project's
 *     auto-memory directory (~/.claude/projects/<proj>/memory).
 *   - session snippets: short text excerpts extracted from the most recent
 *     session transcript (~/.claude/projects/<proj>/*.jsonl), passed as
 *     `--session-snippet`.
 *
 * Everything is best-effort and defensive: any failure yields empty context,
 * which the CLI treats as "nothing to refresh from — skip".
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const log = console.error;

const MAX_SNIPPETS = 12;
const MAX_SNIPPET_CHARS = 280;
// Only look at the tail of a transcript — sessions can be huge.
const MAX_TRANSCRIPT_BYTES = 512 * 1024;

export interface RefreshContext {
  memoryDirs: string[];
  sessionSnippets: string[];
}

export const EMPTY_CONTEXT: RefreshContext = { memoryDirs: [], sessionSnippets: [] };

/** EigenFlux plumbing must never feed back into the bio. */
function isEigenfluxPayload(text: string): boolean {
  return (
    text.includes('Powered by EigenFlux') ||
    text.includes('source="eigenflux"') ||
    text.includes('EigenFlux feed payload') ||
    text.includes('eigenflux feed poll') ||
    text.includes('profile refresh-prompt')
  );
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && (block as { type?: string }).type === 'text'
          ? String((block as { text?: unknown }).text ?? '')
          : ''
      )
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** Newest .jsonl transcript under the given project dir, or null. */
function latestTranscript(projectDir: string): { file: string; mtimeMs: number } | null {
  let best: { file: string; mtimeMs: number } | null = null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    try {
      const full = path.join(projectDir, e.name);
      const mtimeMs = fs.statSync(full).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { file: full, mtimeMs };
    } catch {
      // ignore this entry
    }
  }
  return best;
}

function extractSessionSnippets(transcriptPath: string): string[] {
  let raw: string;
  try {
    const stat = fs.statSync(transcriptPath);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const start = Math.max(0, stat.size - MAX_TRANSCRIPT_BYTES);
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }

  const snippets: string[] = [];
  const lines = raw.split('\n');
  // Walk from the end so we keep the most recent turns.
  for (let i = lines.length - 1; i >= 0 && snippets.length < MAX_SNIPPETS; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      const text = extractText(entry.message?.content).replace(/\s+/g, ' ').trim();
      if (!text || isEigenfluxPayload(text)) continue;
      snippets.push(text.slice(0, MAX_SNIPPET_CHARS));
    } catch {
      // partial/corrupt line (e.g. cut by the tail window) — skip
    }
  }
  return snippets.reverse();
}

/**
 * Collect memory dirs + recent session snippets for the refresh prompt.
 * Best-effort; never throws.
 */
export function collectClaudeCodeContext(): RefreshContext {
  try {
    const claudeHome = path.join(os.homedir(), '.claude');
    const memoryDirs: string[] = [];
    if (fs.existsSync(path.join(claudeHome, 'CLAUDE.md'))) {
      memoryDirs.push(claudeHome);
    }

    // Most recently active project = the one holding the newest transcript.
    const projectsDir = path.join(claudeHome, 'projects');
    let newest: { projectDir: string; transcript: string; mtimeMs: number } | null = null;
    let projects: fs.Dirent[] = [];
    try {
      projects = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      // no projects dir — memory-only context is still fine
    }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const projectDir = path.join(projectsDir, p.name);
      const t = latestTranscript(projectDir);
      if (t && (!newest || t.mtimeMs > newest.mtimeMs)) {
        newest = { projectDir, transcript: t.file, mtimeMs: t.mtimeMs };
      }
    }

    let sessionSnippets: string[] = [];
    if (newest) {
      const memDir = path.join(newest.projectDir, 'memory');
      if (fs.existsSync(memDir)) memoryDirs.push(memDir);
      sessionSnippets = extractSessionSnippets(newest.transcript);
    }

    return { memoryDirs, sessionSnippets };
  } catch (err) {
    log(`[eigenflux:context] collection failed: ${err instanceof Error ? err.message : String(err)}`);
    return EMPTY_CONTEXT;
  }
}
