/** Only a final CLI notice classifies credential acquisition failures. */
function finalNotice(stderr: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stderr.trim().split(/\r?\n/).pop() ?? '');
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function hasIdentity(fields: Record<string, unknown>): boolean {
  return ['code', 'home', 'server'].every((key) =>
    typeof fields[key] === 'string' && (fields[key] as string).trim().length > 0);
}

export function authenticationUnavailable(stderr: string): boolean {
  const fields = finalNotice(stderr);
  return fields !== null && fields.schema_version === 'eigenflux_auth_unavailable.v1' &&
    fields.status === 'auth_unavailable' && fields.checks_blocked === true &&
    fields.login_required === false && fields.retryable === true && hasIdentity(fields);
}

/** Preserve instructions and owner_action from the CLI without inventing login commands. */
export function authRequiredNotice(stderr: string): Record<string, unknown> | null {
  const fields = finalNotice(stderr);
  return fields !== null && fields.schema_version === 'eigenflux_auth_required.v1' &&
    fields.status === 'auth_required' && fields.checks_blocked === true &&
    fields.notification_required === true && hasIdentity(fields) ? fields : null;
}
