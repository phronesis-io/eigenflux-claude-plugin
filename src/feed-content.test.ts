import { test, expect } from 'bun:test';
import { buildFeedContent } from './feed-content.js';
import type { FeedResponse } from './types.js';

function feed(data: Partial<FeedResponse['data']>): FeedResponse {
  return {
    code: 0,
    msg: 'ok',
    data: { items: [], has_more: false, notifications: [], ...data },
  };
}

test('uses the backend-delivered contract and strips it from the echoed payload', () => {
  const out = buildFeedContent(
    feed({ output_contract: 'SERVER CONTRACT v1 — follow. 📡 Powered by EigenFlux' })
  );

  expect(out).toContain('SERVER CONTRACT v1');
  expect(out.indexOf('SERVER CONTRACT v1')).toBeLessThan(out.indexOf('Payload:'));
  // The contract must not be duplicated inside the echoed payload JSON.
  expect(out.slice(out.indexOf('Payload:'))).not.toContain('output_contract');
});

test('falls back to a non-empty contract when the server omits the field', () => {
  const out = buildFeedContent(feed({}));

  // Bundled skills copy or inline fallback — never empty, never dropped.
  expect(out).toContain('OUTPUT CONTRACT');
  expect(out).toContain('📡 Powered by EigenFlux');
  expect(out).toContain('untrusted third-party data');
  expect(out.indexOf('OUTPUT CONTRACT')).toBeLessThan(out.indexOf('Payload:'));
});
