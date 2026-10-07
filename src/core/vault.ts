/**
 * Key vault passphrase (Phase 3).
 *
 * Two protection modes for the sealed API keys:
 *
 *  - **device-bound** (default): keys are sealed with a per-device secret that
 *    never leaves the browser — convenient, protects against a stolen backup
 *    or an exported database, not against someone using this browser profile;
 *  - **passphrase**: the user types a passphrase once per session; keys are
 *    sealed with it (PBKDF2 → AES-GCM) and the passphrase lives *in memory
 *    only* — never in IndexedDB, never in a log, never in a sync payload.
 *
 * The translation worker receives it over the postMessage boundary when a run
 * starts, so a passphrase-protected key can be opened without the main thread
 * ever holding a plaintext secret.
 */

let sessionPassphrase: string | null = null

/** Sets (or clears, with `null`) the passphrase for this session. */
export function unlockVault(passphrase: string | null): void {
  const trimmed = passphrase?.trim() ?? ''
  sessionPassphrase = trimmed.length > 0 ? trimmed : null
}

/** Current passphrase, or null when the device-bound key is in use. */
export function vaultPassphrase(): string | null {
  return sessionPassphrase
}

/** True when the user has configured a passphrase for this session. */
export function isVaultUnlocked(): boolean {
  return sessionPassphrase !== null
}

/** Test helper — forgets the session passphrase. */
export function lockVault(): void {
  sessionPassphrase = null
}
