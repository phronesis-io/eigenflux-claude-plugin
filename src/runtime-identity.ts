/** Explicit override is separate from metadata inherited from another process. */
export function resolveRuntimeHost(override?: string): string {
  const host = override?.trim().toLowerCase();
  if (!host) return 'claude-code';
  if (!/^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?$/.test(host) || ['terminal', 'plugin', 'skill', 'skills', 'cli', 'cli-direct', 'unknown'].includes(host.split('/')[0])) {
    throw new Error('EIGENFLUX_HOST_OVERRIDE must be a product name with an optional product version');
  }
  return host;
}
