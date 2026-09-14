import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('explicit empty contract injects no rules and no fallback', () => {
  // Present-but-empty is the server saying "this payload needs no output
  // rules" (the common empty-poll case) — falling back would reinstate the
  // very rules the server withheld.
  const out = buildFeedContent(feed({ output_contract: '' }));

  expect(out).not.toContain('OUTPUT CONTRACT');
  expect(out).toContain('Payload:');
  expect(out.slice(out.indexOf('Payload:'))).not.toContain('output_contract');
});

test('reads the fallback contract from the CLI-synced Claude Skills directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'eigenflux-claude-skills-'));
  const contractDir = join(root, 'ef-broadcast', 'references');
  mkdirSync(contractDir, { recursive: true });
  writeFileSync(join(contractDir, 'contract.md'), 'SYNCED CLAUDE CONTRACT');
  const previous = process.env.EIGENFLUX_SKILLS_DIR;
  process.env.EIGENFLUX_SKILLS_DIR = root;

  try {
    const out = buildFeedContent(feed({}));
    expect(out).toContain('SYNCED CLAUDE CONTRACT');
    writeFileSync(join(contractDir, 'contract.md'), 'UPDATED CENTRAL CONTRACT');
    expect(buildFeedContent(feed({}))).toContain('UPDATED CENTRAL CONTRACT');
  } finally {
    if (previous === undefined) delete process.env.EIGENFLUX_SKILLS_DIR;
    else process.env.EIGENFLUX_SKILLS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails when neither the server nor synchronized Skills supplies a contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'eigenflux-missing-contract-'));
  const previous = process.env.EIGENFLUX_SKILLS_DIR;
  process.env.EIGENFLUX_SKILLS_DIR = root;
  try {
    expect(() => buildFeedContent(feed({}), 'CENTRAL PLAN')).toThrow('central Feed contract is unavailable');
    expect(buildFeedContent(feed({ output_contract: '' }))).not.toContain('OUTPUT CONTRACT');
    expect(buildFeedContent(feed({ output_contract: 'SERVER CONTRACT' }))).toContain('SERVER CONTRACT');
    const contractDir = join(root, 'ef-broadcast', 'references');
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, 'contract.md'), '   ');
    expect(() => buildFeedContent(feed({}))).toThrow('central Feed contract is empty');
  } finally {
    if (previous === undefined) delete process.env.EIGENFLUX_SKILLS_DIR;
    else process.env.EIGENFLUX_SKILLS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('delivers the current plan and already-pulled Feed together', () => {
  const plan = 'CURRENT CENTRAL PLAN\nRead the current central rules.';
  const out = buildFeedContent(feed({ output_contract: 'SERVER CONTRACT' }), plan);
  expect(out).toContain(plan);
  expect(out.indexOf(plan)).toBeLessThan(out.indexOf('Payload:'));
  expect(out).toContain('without polling Feed again');
  expect(out.split(plan)).toHaveLength(2);
});
