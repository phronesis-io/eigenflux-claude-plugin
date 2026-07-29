/**
 * Generic helper to run `eigenflux` CLI commands as one-shot subprocesses.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import { execFile } from 'child_process';

const log = console.error;

const EXIT_AUTH_REQUIRED = 4;
const DEFAULT_TIMEOUT_MS = 30_000;

export type CliResult<T> =
  | { kind: 'success'; data: T }
  | { kind: 'auth_required'; stderr: string }
  | { kind: 'not_installed'; bin: string }
  | { kind: 'error'; error: Error; exitCode: number | null; stderr: string };

export interface ExecOptions {
  timeout?: number;
  cwd?: string;
  /**
   * When false, return trimmed stdout as-is instead of JSON-parsing it. For
   * plain-text commands (`profile refresh-prompt`, `settings push`, …).
   * Defaults to true.
   */
  parseJson?: boolean;
}

// Flags whose values carry free text from the user's sessions/memory. Their
// values must never reach the exec log: Claude Code persists this process's
// stderr to disk (mcp-logs-*), so logging them verbatim would copy session
// transcript excerpts — potentially containing pasted secrets — into a
// second, long-lived plaintext location.
const REDACTED_VALUE_FLAGS = new Set(['--session-snippet']);

export function formatArgsForLog(args: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    out.push(args[i]);
    if (REDACTED_VALUE_FLAGS.has(args[i]) && i + 1 < args.length) {
      out.push(`<redacted ${args[i + 1].length} chars>`);
      i++;
    }
  }
  return out.join(' ');
}

export function execEigenflux<T>(
  bin: string,
  args: string[],
  options?: ExecOptions
): Promise<CliResult<T>> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    log(`[eigenflux:cli] exec: ${bin} ${formatArgsForLog(args)}`);

    execFile(
      bin,
      args,
      {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf-8',
        ...(options?.cwd ? { cwd: options.cwd } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          // Spawn failures carry a STRING code (e.g. 'ENOENT' when the binary is
          // missing); process exits carry a NUMERIC code. Distinguish them so a
          // missing CLI is reported as not_installed and can never be mistaken
          // for an exit status (e.g. auth_required's 4).
          if (exitCode === 'ENOENT') {
            log(`[eigenflux:cli] binary not found: ${bin}`);
            resolve({ kind: 'not_installed', bin });
            return;
          }
          const numericExit =
            typeof exitCode === 'number'
              ? exitCode
              : error.killed
                ? null
                : (error as any).status ?? null;

          if (numericExit === EXIT_AUTH_REQUIRED) {
            log(`[eigenflux:cli] auth required: ${stderr.trim()}`);
            resolve({ kind: 'auth_required', stderr: stderr.trim() });
            return;
          }

          log(`[eigenflux:cli] failed (exit=${numericExit}): ${stderr.trim() || error.message}`);
          resolve({
            kind: 'error',
            error: new Error(stderr.trim() || error.message),
            exitCode: numericExit,
            stderr: stderr.trim(),
          });
          return;
        }

        const trimmed = stdout.trim();
        if (options?.parseJson === false) {
          resolve({ kind: 'success', data: trimmed as unknown as T });
          return;
        }
        if (!trimmed) {
          resolve({
            kind: 'success',
            data: undefined as unknown as T,
          });
          return;
        }

        try {
          const data = JSON.parse(trimmed) as T;
          resolve({ kind: 'success', data });
        } catch (parseError) {
          log(`[eigenflux:cli] JSON parse error: ${(parseError as Error).message}`);
          resolve({
            kind: 'error',
            error: new Error(`Failed to parse CLI output: ${(parseError as Error).message}`),
            exitCode: 0,
            stderr: '',
          });
        }
      }
    );
  });
}
