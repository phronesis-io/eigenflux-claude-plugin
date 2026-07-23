import { test, expect } from 'bun:test';
import { FeedbackFlushLoop, type ExecFn } from './feedback-flush-loop.js';
import type { CliResult } from './cli-executor.js';

function loopWith(results: Array<CliResult<unknown>>, calls: string[][]): FeedbackFlushLoop {
  let i = 0;
  const exec: ExecFn = (async (_bin: string, args: string[]) => {
    calls.push(args);
    const r = results[Math.min(i, results.length - 1)];
    i += 1;
    return r;
  }) as ExecFn;
  return new FeedbackFlushLoop({
    serverName: 'srv',
    eigenfluxBin: 'eigenflux',
    baseBackoffMs: 10,
    maxBackoffMs: 40,
    exec,
  });
}

const flushOk = (remaining = 0): CliResult<unknown> => ({ kind: 'success', data: { flushed: 1, remaining, ok: true } });
const flushFailedPending = (remaining: number): CliResult<unknown> => ({ kind: 'success', data: { flushed: 0, remaining, ok: false } });

async function settle(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

test('start kicks one flush; clean flush does not re-arm', async () => {
  const calls: string[][] = [];
  const loop = loopWith([flushOk()], calls);
  loop.start();
  await settle(30);
  loop.stop();
  expect(calls.length).toBe(1);
  expect(calls[0].slice(0, 3)).toEqual(['feed', 'event', 'flush']);
});

test('failed flush with pending events retries with growing back-off until clean', async () => {
  const calls: string[][] = [];
  const loop = loopWith([flushFailedPending(3), flushFailedPending(3), flushOk()], calls);
  loop.start();
  // base 10ms + doubled 20ms + margin — three ticks should have happened.
  await settle(120);
  loop.stop();
  expect(calls.length).toBe(3);
});

test('kick triggers an immediate flush; stop cancels pending retries', async () => {
  const calls: string[][] = [];
  const loop = loopWith([flushOk()], calls);
  loop.start();
  await settle(20);
  loop.kick();
  await settle(20);
  expect(calls.length).toBe(2);
  loop.stop();
  const after = calls.length;
  await settle(60);
  expect(calls.length).toBe(after);
});

test('kick before start is a no-op', async () => {
  const calls: string[][] = [];
  const loop = loopWith([flushOk()], calls);
  loop.kick();
  await settle(20);
  expect(calls.length).toBe(0);
});

test('CLI errors never throw and never arm a retry storm', async () => {
  const calls: string[][] = [];
  const loop = loopWith([{ kind: 'error', error: new Error('boom'), exitCode: 1, stderr: '' }], calls);
  loop.start();
  await settle(80);
  loop.stop();
  // Error result (not success+pending) → no retry armed.
  expect(calls.length).toBe(1);
});
