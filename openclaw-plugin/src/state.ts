/**
 * State module — retained for compatibility but silence functionality
 * was removed in v1.6.0. initState is a no-op; isSilenced always returns false.
 */

export function initState(_pluginDir: string): void {
  // no-op
}

export function isSilenced(_channelId: string): boolean {
  return false;
}
