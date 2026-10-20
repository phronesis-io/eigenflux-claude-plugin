import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MainNoticeACP } from './main-notice-acp.js';
import { runMainNoticeHook as runHook, HookOptions } from './main-notice-hook.js';
import { supportsMainNoticeClaudeVersion } from './main-notice-host.js';
import { MAIN_NOTICE_CAPABILITY, MAIN_NOTICE_LEASE_MS, MainNoticeStore } from './main-notice-store.js';

const runMainNoticeHook = (input: Parameters<typeof runHook>[0], store: MainNoticeStore, options: HookOptions = {}) =>
  runHook(input, store, { verifyHost: () => true, ...options });

const fixtures: Array<{ root: string; store: MainNoticeStore }> = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ef-claude-main-')));
  const store = new MainNoticeStore(join(root, 'private', 'bridge.sqlite'));
  fixtures.push({ root, store });
  const target = { sessionId: 'session-eigenflux-1', cwd: root };
  const hook = { session_id: target.sessionId, cwd: root, hook_event_name: 'SessionStart' };
  const request = { ...target, requestId: 'request-1', prompt: '已付款，检查当前订单并只展示处理结果。' };
  const versionFile = join(root, 'fake-claude-version.mjs');
  writeFileSync(versionFile, 'process.stdout.write("2.1.295 (Claude Code)\\n");');
  const versionCommand = JSON.stringify([process.execPath, versionFile]);
  return { root, store, target, hook, request, versionCommand };
}
afterEach(() => {
  for (const { root, store } of fixtures.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); }
});

describe('exact existing Claude hook owner', () => {
  test('no known hook owner is unavailable and cannot create a session', () => {
    const { store, target, request } = fixture();
    expect(() => store.inspect(target)).toThrow('main_session_not_idle_or_unavailable');
    expect(() => store.admit(request)).toThrow('main_session_not_idle_or_unavailable');
  });
  test('session and cwd never fall back; expired leases are not idle', () => {
    const { store, target, hook } = fixture();
    store.listen(hook);
    expect(store.inspect(target).sessionId).toBe(target.sessionId);
    expect(() => store.inspect({ ...target, sessionId: 'other' })).toThrow();
    expect(() => store.inspect({ ...target, cwd: '/missing-eigenflux-test-path' })).toThrow();
    expect(() => store.inspect(target, Date.now() + MAIN_NOTICE_LEASE_MS + 10)).toThrow();
  });
  test('hidden handoff, exact receipt, and durable duplicate refusal', () => {
    const { store, hook, target, request } = fixture();
    const listener = store.listen(hook);
    store.admit(request);
    const claimed = store.tick(target, listener);
    expect(claimed.wake).toContain(request.prompt);
    expect(store.tick(target, listener).wake).toBeUndefined();
    expect(store.receipt(request)).toBeNull();
    store.observe({ ...hook, hook_event_name: 'Stop', last_assistant_message: '任务已交付，请检查结果。' });
    expect(store.receipt(request)).toMatchObject({ sessionId: target.sessionId, requestId: request.requestId,
      hiddenInput: true, stopReason: 'end_turn', text: '任务已交付，请检查结果。' });
    expect(() => store.admit(request)).toThrow('main_notice_already_attempted');
  });
  test('a pending admission is busy and cannot accept another event', () => {
    const { store, hook, target, request } = fixture(); store.listen(hook); store.admit(request);
    expect(() => store.inspect(target)).toThrow('main_session_not_idle_or_unavailable');
    expect(() => store.admit({ ...request, requestId: 'second-request' })).toThrow('main_session_not_idle_or_unavailable');
  });
  test('a previous Stop response cannot acknowledge a later event', () => {
    const { store, hook, target, request } = fixture();
    const listener = store.listen({ ...hook, last_assistant_message: '此前已完成。' });
    store.admit(request); store.tick(target, listener);
    store.observe({ ...hook, hook_event_name: 'Stop', last_assistant_message: '此前已完成。' });
    expect(() => store.receipt(request)).toThrow('main_notice_result_unknown');
  });
  test('duplicate Stop cannot complete the next notification', () => {
    const { store, hook, target, request } = fixture();
    const listener = store.listen(hook); store.admit(request); store.tick(target, listener);
    const stop = { ...hook, hook_event_name: 'Stop', last_assistant_message: '上一条通知处理结果' };
    store.observe(stop);
    const nextListener = store.listen(stop);
    const next = { ...request, requestId: 'request-2' }; store.admit(next); store.tick(target, nextListener);
    store.observe(stop);
    expect(() => store.receipt(next)).toThrow('main_notice_result_unknown');
    expect(store.receipt(request)?.text).toBe(stop.last_assistant_message);
  });
  test('queued notification invalidates before a human turn without retaining human text', () => {
    const { store, hook, target, request, root } = fixture();
    const listener = store.listen(hook); store.admit(request);
    store.observe({ ...hook, hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE-HUMAN-INPUT-123' });
    expect(store.tick(target, listener).wake).toBeUndefined();
    store.observe({ ...hook, hook_event_name: 'Stop', last_assistant_message: '人类问题的回答。' });
    expect(() => store.receipt(request)).toThrow('main_notice_result_unknown');
    expect(readFileSync(join(root, 'private', 'bridge.sqlite')).includes(Buffer.from('PRIVATE-HUMAN-INPUT-123'))).toBe(false);
  });
  test('human input after injection prevents misattributing the human reply', () => {
    const { store, hook, target, request } = fixture();
    const listener = store.listen(hook); store.admit(request); store.tick(target, listener);
    store.observe({ ...hook, hook_event_name: 'UserPromptSubmit', prompt: '另一个用户问题' });
    store.observe({ ...hook, hook_event_name: 'Stop', last_assistant_message: '另一个问题的答案' });
    expect(() => store.receipt(request)).toThrow('main_notice_result_unknown');
    expect(() => store.admit(request)).toThrow('main_notice_already_attempted');
  });
  test('a host echo of the exact private reminder preserves attribution', () => {
    const { store, hook, target, request } = fixture();
    const listener = store.listen(hook); store.admit(request);
    const { wake } = store.tick(target, listener);
    store.observe({ ...hook, hook_event_name: 'UserPromptSubmit', prompt: wake });
    store.observe({ ...hook, hook_event_name: 'Stop', last_assistant_message: '通知已处理' });
    expect(store.receipt(request)?.text).toBe('通知已处理');
  });
  test('a new owner, session end, and failed turn all refuse a prior receipt', () => {
    for (const event of ['SessionStart', 'SessionEnd', 'StopFailure']) {
      const { store, hook, target, request } = fixture();
      const listener = store.listen(hook); store.admit(request); store.tick(target, listener);
      if (event === 'SessionStart') store.listen(hook);
      else store.observe({ ...hook, hook_event_name: event });
      store.observe({ ...hook, hook_event_name: 'Stop', last_assistant_message: '不能算作旧通知回执' });
      expect(() => store.receipt(request)).toThrow('main_notice_result_unknown');
    }
  });
  test('expired requests are not injected, completed, or retried', () => {
    const { store, hook, target, request } = fixture();
    const listener = store.listen(hook); store.admit(request, 1);
    expect(store.tick(target, listener, Date.now() + 10).wake).toBeUndefined();
    expect(() => store.receipt(request)).toThrow('main_notice_result_unknown');
    expect(() => store.admit(request)).toThrow('main_notice_already_attempted');
  });
  test('a dead caller cannot leave a queued event for later injection', async () => {
    const { store, hook, target, request } = fixture(); const listener = store.listen(hook);
    const source = `import { MainNoticeStore } from ${JSON.stringify(fileURLToPath(new URL('./main-notice-store.ts', import.meta.url)))};
      const store = new MainNoticeStore(process.env.FIXTURE_DB); store.admit(JSON.parse(process.env.FIXTURE_REQUEST)); store.close();`;
    const child = Bun.spawn([process.execPath, '-e', source], {
      stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH, HOME: target.cwd,
        EIGENFLUX_HOME: target.cwd, FIXTURE_DB: store.file, FIXTURE_REQUEST: JSON.stringify(request) },
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe('');
    expect(store.tick(target, listener).wake).toBeUndefined();
    expect(() => store.receipt(request)).toThrow('main_notice_result_unknown');
  });
  test('wrong-target receipt and prompt/control overflow fail closed', () => {
    const { store, hook, request } = fixture(); store.listen(hook); store.admit(request);
    expect(() => store.receipt({ ...request, sessionId: 'wrong' })).toThrow('main_notice_receipt_mismatch');
    expect(() => store.admit({ ...request, requestId: 'new', prompt: 'x'.repeat(32769) })).toThrow();
    expect(() => store.admit({ ...request, requestId: 'new', prompt: 'bad\u0000text' })).toThrow();
  });
  test('restart never replays a previously injected request', () => {
    const { store, hook, target, request, root } = fixture();
    const listener = store.listen(hook); store.admit(request); store.tick(target, listener);
    const second = new MainNoticeStore(join(root, 'private', 'bridge.sqlite'));
    try {
      second.listen(hook);
      expect(() => second.admit(request)).toThrow('main_notice_already_attempted');
      expect(() => second.receipt(request)).toThrow('main_notice_result_unknown');
    } finally { second.close(); }
  });
  test.skipIf(process.platform === 'win32')('rejects a shared or symlinked database', () => {
    const { root } = fixture();
    const shared = join(root, 'shared');
    const a = new MainNoticeStore(join(shared, 'bridge.sqlite')); a.close(); chmodSync(shared, 0o755);
    expect(() => new MainNoticeStore(join(shared, 'bridge.sqlite'))).toThrow('main_bridge_directory_not_private');
    symlinkSync(join(root, 'private'), join(root, 'linked'));
    expect(() => new MainNoticeStore(join(root, 'linked', 'bridge.sqlite'))).toThrow('main_bridge_directory_invalid');
  });
});

describe('official asyncRewake handoff fixture', () => {
  test('real hook subprocess reads fixture stdin, writes no stdout, and exits 2 only once', async () => {
    const { store, hook, target, request, versionCommand } = fixture();
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./main-notice-hook.ts', import.meta.url))], {
      stdin: new Blob([JSON.stringify(hook)]), stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH, HOME: target.cwd, EIGENFLUX_HOME: target.cwd,
        EIGENFLUX_MAIN_BRIDGE_HOME: dirname(store.file), EIGENFLUX_CLAUDE_VERSION_COMMAND: versionCommand },
    });
    try {
      const deadline = Date.now() + 3000;
      while (true) {
        try { store.inspect(target); break; } catch { if (Date.now() > deadline) throw new Error('fixture hook not ready'); }
        await Bun.sleep(5);
      }
      store.admit(request);
      expect(await child.exited).toBe(2);
      expect(await new Response(child.stdout).text()).toBe('');
      expect(await new Response(child.stderr).text()).toContain(request.prompt);
      store.observe({ ...hook, hook_event_name: 'Stop', last_assistant_message: '本次通知的结果' });
      expect(store.receipt(request)?.text).toBe('本次通知的结果');
      expect(() => store.admit(request)).toThrow('main_notice_already_attempted');
    } finally { child.kill(); await child.exited; }
  });
  test('oversized real hook input invalidates outstanding attribution quietly', async () => {
    const { store, hook, target, request } = fixture();
    const listener = store.listen(hook); store.admit(request); store.tick(target, listener);
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./main-notice-hook.ts', import.meta.url))], {
      stdin: new Blob([JSON.stringify({ ...hook, hook_event_name: 'UserPromptSubmit', prompt: 'x'.repeat(140000) })]),
      stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH, HOME: target.cwd, EIGENFLUX_HOME: target.cwd,
        EIGENFLUX_MAIN_BRIDGE_HOME: dirname(store.file) },
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toBe('');
    expect(await new Response(child.stderr).text()).toBe('');
    expect(() => store.receipt(request)).toThrow('main_notice_result_unknown');
  });
  test('real ACP subprocess uses newline JSON and rejects ordinary session methods', async () => {
    const { store, hook, target } = fixture(); store.listen(hook);
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } },
      { jsonrpc: '2.0', id: 2, method: '_eigenflux/main/inspect', params: target },
      { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: target },
    ];
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./main-notice-acp.ts', import.meta.url))], {
      stdin: new Blob([requests.map((request) => JSON.stringify(request)).join('\n') + '\n']), stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH, HOME: target.cwd, EIGENFLUX_HOME: target.cwd,
        EIGENFLUX_MAIN_BRIDGE_HOME: dirname(store.file) },
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe('');
    const responses = (await new Response(child.stdout).text()).trim().split('\n').map((line) => JSON.parse(line));
    expect(responses).toHaveLength(3);
    expect(responses.find((reply) => reply.id === 2).result).toMatchObject({ sessionId: target.sessionId, state: 'idle' });
    expect(responses.find((reply) => reply.id === 3).error).toMatchObject({ code: -32601, message: 'method_not_found' });
  });
  test('only a claimed event writes private stderr and exits 2', async () => {
    const { store, hook, target, request } = fixture();
    const output: string[] = [];
    const listening = runMainNoticeHook(hook, store, { pollMs: 2, maxWaitMs: 2000, writeContext: (text) => output.push(text) });
    store.inspect(target); store.admit(request);
    expect(await listening).toBe(2);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain(request.prompt);
    expect(store.receipt(request)).toBeNull();
  });
  test('no event or human input exits quietly with no context', async () => {
    const { store, hook } = fixture(); const output: string[] = [];
    expect(await runMainNoticeHook(hook, store, { maxWaitMs: 2, pollMs: 2, writeContext: (text) => output.push(text) })).toBe(0);
    expect(output).toEqual([]);
  });
  test('unsupported host versions do not publish a ready listener', async () => {
    const { store, hook, target } = fixture();
    expect(await runMainNoticeHook(hook, store, { verifyHost: () => false })).toBe(0);
    expect(() => store.inspect(target)).toThrow('main_session_not_idle_or_unavailable');
    for (const raw of ['2.1.294 (Claude Code)', '2.1.304 (CodeBuddy)', 'unknown', '2.1.295']) expect(supportsMainNoticeClaudeVersion(raw)).toBe(false);
    for (const raw of ['2.1.295 (Claude Code)', '2.1.304 (Claude Code)\n']) expect(supportsMainNoticeClaudeVersion(raw)).toBe(true);
  });
  test('ACP negotiates the extension and never calls ordinary ACP session methods', async () => {
    const { store, hook, target, request } = fixture(); const agent = new MainNoticeACP(store);
    await expect(agent.handle({ jsonrpc: '2.0', id: 0, method: '_eigenflux/main/inspect', params: target })).rejects.toThrow('initialize_required');
    const init = await agent.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) as any;
    expect(init.agentCapabilities._meta[MAIN_NOTICE_CAPABILITY]).toMatchObject({ host: 'claude-code', hiddenInput: true, existingSession: true });
    for (const method of ['session/new', 'session/load', 'session/prompt']) {
      await expect(agent.handle({ jsonrpc: '2.0', id: 2, method, params: target })).rejects.toThrow('method_not_found');
    }
    const listening = runMainNoticeHook(hook, store, { pollMs: 2, maxWaitMs: 2000, writeContext() {} });
    const completed = agent.handle({ jsonrpc: '2.0', id: 3, method: '_eigenflux/main/notify', params: request });
    expect(await listening).toBe(2);
    await runMainNoticeHook({ ...hook, hook_event_name: 'Stop', last_assistant_message: '订单已交付，请确认。' }, store, { maxWaitMs: 2, pollMs: 2 });
    const receipt = await completed;
    expect(receipt).toMatchObject({ requestId: request.requestId, text: '订单已交付，请确认。', stopReason: 'end_turn' });
    expect(Object.keys(receipt as object).sort()).toEqual(['existingSession', 'hiddenInput', 'requestId', 'resultOnly', 'runId', 'sessionId', 'stopReason', 'text']);
  });
  test('ACP disconnect abandons the attempt without replay or host interruption', async () => {
    const { store, hook, target, request } = fixture(); store.listen(hook);
    const controller = new AbortController(); const agent = new MainNoticeACP(store, controller.signal);
    await agent.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    const result = agent.handle({ jsonrpc: '2.0', id: 2, method: '_eigenflux/main/notify', params: request });
    controller.abort();
    await expect(result).rejects.toThrow('main_notice_result_unknown');
    expect(() => store.admit(request)).toThrow('main_notice_already_attempted');
    expect(store.tick(target, store.listen({ ...hook, hook_event_name: 'Stop' })).wake).toBeUndefined();
  });
  test('manifest uses official hooks and includes hooks in the package', () => {
    const config = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
    for (const name of ['SessionStart', 'Stop']) {
      expect(config.hooks[name][0].hooks[0]).toMatchObject({ type: 'command', command: 'bun', async: true, asyncRewake: true });
    }
    expect(config.hooks.UserPromptSubmit[0].hooks[0].asyncRewake).toBeUndefined();
    expect(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).files).toContain('hooks');
  });
});
