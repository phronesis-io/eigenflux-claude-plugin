/** ACP v1 extension only: never starts or resumes a Claude process. */
import { createInterface } from 'node:readline';
import { CONFIG } from './config.js';
import { MAIN_NOTICE_CAPABILITY, MAIN_NOTICE_HOST, MAIN_NOTICE_MAX_BYTES, MAIN_NOTICE_WAIT_MS,
  MainNoticeError, MainNoticeRequest, MainNoticeStore, MainNoticeTarget } from './main-notice-store.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
interface RpcRequest { jsonrpc: '2.0'; id?: string | number; method: string; params?: Record<string, unknown> }
export class MainNoticeACP {
  private initialized = false;
  constructor(private readonly store: MainNoticeStore, private readonly signal?: AbortSignal) {}
  async handle(request: RpcRequest): Promise<unknown> {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
      || (request.params !== undefined && (!request.params || Array.isArray(request.params) || typeof request.params !== 'object'))) {
      throw new MainNoticeError('invalid_request');
    }
    const params = request.params || {};
    if (request.method === 'initialize') {
      if (params.protocolVersion !== 1) throw new MainNoticeError('unsupported_protocol_version');
      this.initialized = true;
      return { protocolVersion: 1, agentInfo: { name: 'eigenflux-claude-main-notice', version: CONFIG.PLUGIN_VERSION },
        agentCapabilities: { loadSession: false, _meta: { [MAIN_NOTICE_CAPABILITY]: {
          version: 1, host: MAIN_NOTICE_HOST, existingSession: true, hiddenInput: true, resultOnly: true,
        } } } };
    }
    if (!this.initialized) throw new MainNoticeError('initialize_required');
    if (request.method === '_eigenflux/main/inspect') {
      if (Object.keys(params).some((key) => !['sessionId', 'cwd'].includes(key))) throw new MainNoticeError('invalid_request');
      return this.store.inspect(params as unknown as MainNoticeTarget);
    }
    if (request.method !== '_eigenflux/main/notify') throw new MainNoticeError('method_not_found');
    if (Object.keys(params).some((key) => !['sessionId', 'cwd', 'requestId', 'prompt'].includes(key))) throw new MainNoticeError('invalid_request');
    const input = params as unknown as MainNoticeRequest;
    this.store.admit(input);
    const deadline = Date.now() + MAIN_NOTICE_WAIT_MS;
    try {
      while (!this.signal?.aborted && Date.now() < deadline) {
        const receipt = this.store.receipt(input);
        if (receipt) return {
          sessionId: receipt.sessionId, requestId: receipt.requestId, runId: receipt.runId,
          stopReason: receipt.stopReason, text: receipt.text,
          existingSession: true, hiddenInput: true, resultOnly: true,
        };
        await sleep(100);
      }
      throw new MainNoticeError('main_notice_result_unknown');
    } finally { this.store.abandon(input); }
  }
}

if (import.meta.main) {
  const abort = new AbortController();
  const store = new MainNoticeStore();
  const agent = new MainNoticeACP(store, abort.signal);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stop = () => { abort.abort(); lines.close(); process.stdin.destroy(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const running = new Set<Promise<void>>();
  const reply = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  lines.on('line', (line) => {
    let request: RpcRequest;
    try {
      if (Buffer.byteLength(line) > MAIN_NOTICE_MAX_BYTES * 3) throw new Error();
      request = JSON.parse(line) as RpcRequest;
    } catch { reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid_request' } }); return; }
    if (!Object.hasOwn(request, 'id')) return;
    const task = (async () => {
      try { reply({ jsonrpc: '2.0', id: request.id, result: await agent.handle(request) }); }
      catch (error) {
        const reason = error instanceof MainNoticeError ? error.reason : 'main_bridge_unavailable';
        reply({ jsonrpc: '2.0', id: request.id, error: {
          code: reason === 'method_not_found' ? -32601 : -32000, message: reason,
        } });
      }
    })();
    running.add(task); void task.finally(() => running.delete(task));
  });
  await new Promise<void>((resolve) => lines.on('close', resolve));
  abort.abort();
  await Promise.allSettled(running);
  store.close();
}
