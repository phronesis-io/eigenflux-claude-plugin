import { expect, test } from 'bun:test';
import { authenticationUnavailable, authRequiredNotice } from './auth-notices.js';
import { execEigenflux } from './cli-executor.js';

const unavailable = {
  schema_version: 'eigenflux_auth_unavailable.v1', status: 'auth_unavailable',
  code: 'RECOVERY_RATE_LIMITED', home: '/stable/home', server: 'staging',
  checks_blocked: true, login_required: false, retryable: true,
};

test('only the complete final structured credential notice classifies unavailable', () => {
  expect(authenticationUnavailable(`warning\n${JSON.stringify(unavailable)}\n`)).toBe(true);
  for (const changed of [
    { schema_version: 'future_auth.v2' }, { status: 'future_status' },
    { checks_blocked: false }, { login_required: true }, { retryable: false },
    { code: '' }, { home: '' }, { server: '' },
  ]) {
    expect(authenticationUnavailable(JSON.stringify({ ...unavailable, ...changed }))).toBe(false);
  }
  for (const stderr of ['HTTP 503 AGENT_AUTH_UNAVAILABLE', 'HTTP 429 RECOVERY_RATE_LIMITED',
    `${JSON.stringify(unavailable)}\nlater output`, 'null', '[]', '{}', '{invalid']) {
    expect(authenticationUnavailable(stderr)).toBe(false);
  }
});

test('preserves the CLI owner action and instruction without changing their wording', () => {
  const notice = {
    schema_version: 'eigenflux_auth_required.v1', status: 'auth_required',
    code: 'IDENTITY_UNAVAILABLE', home: '/stable/home', server: 'staging',
    checks_blocked: true, notification_required: true,
    instruction: 'CURRENT CLI INSTRUCTION', owner_action: 'CURRENT CLI OWNER ACTION',
  };
  expect(authRequiredNotice(`warning\n${JSON.stringify(notice)}`)).toEqual(notice);
  expect(authRequiredNotice('legacy authentication diagnostic')).toBeNull();
});

test('real child exit 2 classifies the CLI notice while other exits and ordinary failures do not', async () => {
  for (const [exit, stderr, expected] of [
    [2, `warning\n${JSON.stringify(unavailable)}`, true],
    [1, JSON.stringify(unavailable), undefined],
    [2, 'HTTP 503 backend unavailable', undefined],
    [2, 'HTTP 429 business endpoint rate limited', undefined],
    [2, JSON.stringify({ ...unavailable, schema_version: 'unknown.v2' }), undefined],
  ] as const) {
    const result = await execEigenflux(process.execPath, ['-e',
      `process.stderr.write(${JSON.stringify(stderr)});process.exit(${exit})`]);
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('expected process error');
    expect(result.authenticationUnavailable).toBe(expected);
    expect(result.stderr).toBe(stderr);
  }
  const required = await execEigenflux(process.execPath, ['-e',
    'process.stderr.write("legacy auth detail");process.exit(4)']);
  expect(required).toEqual({ kind: 'auth_required', stderr: 'legacy auth detail' });
});
