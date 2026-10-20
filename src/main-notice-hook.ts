import { MainNoticeError, MainNoticeHookInput, MainNoticeStore, MAIN_NOTICE_HOOK_MS } from './main-notice-store.js';
import { probeMainNoticeClaude } from './main-notice-host.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export interface HookOptions {
  signal?: AbortSignal; pollMs?: number; maxWaitMs?: number;
  writeContext?: (text: string) => void;
  verifyHost?: () => boolean;
}

/** Exit 2 is Claude's documented asyncRewake handoff, never a visible user prompt. */
export async function runMainNoticeHook(
  input: MainNoticeHookInput, store: MainNoticeStore, options: HookOptions = {},
): Promise<number> {
  const waits = input.hook_event_name === 'SessionStart' || input.hook_event_name === 'Stop';
  if (!waits && !['UserPromptSubmit', 'SessionEnd', 'StopFailure'].includes(input.hook_event_name)) return 0;
  store.observe(input);
  if (!waits || options.signal?.aborted) return 0;
  if (!(options.verifyHost ?? probeMainNoticeClaude)()) return 0;
  const target = { sessionId: input.session_id, cwd: input.cwd };
  const listener = store.listen(input);
  const until = Date.now() + Math.min(options.maxWaitMs ?? MAIN_NOTICE_HOOK_MS, MAIN_NOTICE_HOOK_MS);
  try {
    while (!options.signal?.aborted && Date.now() < until) {
      const next = store.tick(target, listener);
      if (next.wake) {
        // This is the sole non-JSON output path, read privately by the originating hook owner.
        (options.writeContext ?? ((text) => process.stderr.write(text)))(next.wake);
        return 2;
      }
      if (!next.active) return 0;
      await sleep(options.pollMs ?? 200);
    }
    return 0;
  } finally { store.stopListening(target, listener); }
}

if (import.meta.main) {
  let store: MainNoticeStore | undefined;
  try {
    store = new MainNoticeStore();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += Buffer.byteLength(chunk);
      if (size > 128 * 1024) throw new MainNoticeError('hook_input_too_large');
      chunks.push(Buffer.from(chunk));
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as MainNoticeHookInput;
    process.exitCode = await runMainNoticeHook(input, store);
  } catch {
    // Hook failures must neither block a human turn nor expose event/credential contents.
    // If even the session identifiers cannot be trusted, no pending local receipt remains valid.
    try { store?.failClosed(); } catch { /* the unavailable store cannot admit new events */ }
    process.exitCode = 0;
  } finally { store?.close(); }
}
