/**
 * The one place a saved host turns into the credential a dial carries.
 *
 * `HostAuth` only names opaque ids — a key-vault handle, a sealed secret id —
 * so every secret is resolved here, at dial time, and never touches storage.
 * Lookup failures are treated as "nothing remembered": sshj then asks for the
 * passphrase instead of failing auth with an empty one (Plan 4, Review Focus 1).
 */
import type { SshCredential } from '@pocketshell/core';
import type { HostAuth } from '@/platform/android/hostStore';
import { t } from '../i18n';

/** Resolves a sealed secret by id; `null` when it is absent or undecryptable. */
export type SecretLookup = (secretId: string) => Promise<string | null>;

/** A password host whose sealed password is gone, so the dial cannot proceed. */
export class MissingPasswordCredential extends Error {
  constructor() {
    super(t('credential.passwordLost'));
    this.name = 'MissingPasswordCredential';
  }
}

/** A host record naming an auth method this build does not know. */
export class UnsupportedHostAuth extends Error {
  constructor(kind: unknown) {
    super(`Unsupported saved-host auth method: ${String(kind)}.`);
    this.name = 'UnsupportedHostAuth';
  }
}

export async function buildSshCredential(auth: HostAuth, lookup: SecretLookup): Promise<SshCredential> {
  if (auth.kind === 'key') {
    // Only a record that asks for a remembered secret may touch the store; a
    // stale `secretId` with remembering off belongs to Task 4's cleanup.
    if (auth.rememberPassphrase !== true || !auth.secretId) {
      return { kind: 'key-handle', handleId: auth.keyHandleId, passphrase: null };
    }
    return {
      kind: 'key-handle',
      handleId: auth.keyHandleId,
      passphrase: await resolveSecret(lookup, auth.secretId),
    };
  }
  if (auth.kind === 'password') {
    const password = await resolveSecret(lookup, auth.passwordCredentialId);
    if (!password) throw new MissingPasswordCredential();
    return { kind: 'password', password };
  }
  throw new UnsupportedHostAuth((auth as { kind?: unknown }).kind);
}

/** Never throws: an absent, empty or unreadable secret is "not remembered". */
async function resolveSecret(lookup: SecretLookup, secretId: string): Promise<string | null> {
  try {
    const secret = await lookup(secretId);
    return secret ? secret : null;
  } catch {
    return null;
  }
}
