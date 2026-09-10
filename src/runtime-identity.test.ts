import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { resolveRuntimeHost } from './runtime-identity.js';

test('the native product has no invented version', () => {
  expect(resolveRuntimeHost()).toBe('claude-code');
  expect(resolveRuntimeHost(' ')).toBe('claude-code');
});

test('a deliberate host override is validated separately from inherited metadata', () => {
  expect(resolveRuntimeHost('CLAUDE-CODE/2.1.0')).toBe('claude-code/2.1.0');
  expect(() => resolveRuntimeHost('terminal')).toThrow('EIGENFLUX_HOST_OVERRIDE');
  expect(() => resolveRuntimeHost('bad/host/version')).toThrow('EIGENFLUX_HOST_OVERRIDE');
});


test('config propagates independent identity to a CLI child', () => {
  const result = spawnSync(process.execPath, ['-e', `
    await import('./src/config.ts');
    const { execEigenflux } = await import('./src/cli-executor.ts');
    const child = await execEigenflux(process.execPath, ['-e', 'console.log(JSON.stringify({host:process.env.EIGENFLUX_HOST,mode:process.env.EIGENFLUX_MODE,plugin:process.env.EIGENFLUX_PLUGIN_VERSION}))']);
    process.stdout.write(JSON.stringify(child.kind === 'success' ? child.data : child));
    process.exit(child.kind === 'success' ? 0 : 1);
  `], {cwd: new URL('..', import.meta.url).pathname, encoding:'utf8',
    env:{...process.env,EIGENFLUX_HOST:'openclaw/old-plugin',EIGENFLUX_MODE:'skill',EIGENFLUX_HOST_OVERRIDE:''}});
  expect(result.status).toBe(0);
  const identity = JSON.parse(result.stdout);
  expect(identity.host).toBe('claude-code');
  expect(identity.mode).toBe('plugin');
  expect(identity.plugin).toBe('0.0.13');
});

for (const host of ['plugin', 'skill/1', 'skills', 'unknown', 'terminal/1']) {
  test(`rejects mode sentinel ${host} as a product`, () => {
    expect(() => resolveRuntimeHost(host)).toThrow('EIGENFLUX_HOST_OVERRIDE');
  });
}
