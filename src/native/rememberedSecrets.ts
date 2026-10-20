import { type Plugin } from '@capacitor/core';
import { isUuidShapedId, sshKeyVault } from './sshKeyVault';

export type RememberedSecretKind = 'key-passphrase' | 'password';

/**
 * The Android-Keystore-sealed store behind `SshKeyVault`'s remembered-secret
 * bridge methods. A secret is referenced by id from the host record and never
 * reaches the WebView storage layer.
 */
export interface RememberedSecrets {
  put(secret: string, kind: RememberedSecretKind, secretId?: string): Promise<string>;
  resolve(secretId: string): Promise<string | null>;
  forget(secretId: string): Promise<void>;
}

export type NativeRememberedSecretsPlugin = Plugin & {
  rememberSecret(options: {
    secret: string;
    kind: RememberedSecretKind;
    secretId?: string;
  }): Promise<unknown>;
  resolveSecret(options: { secretId: string }): Promise<unknown>;
  forgetSecret(options: { secretId: string }): Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the native replies so a malformed id can never silently orphan a
 * sealed secret, and a missing/undecryptable secret reads as "not remembered"
 * (a Keystore reset is not a reason to hand the dial path an empty secret).
 */
export function createRememberedSecrets(plugin: NativeRememberedSecretsPlugin): RememberedSecrets {
  return {
    async put(secret: string, kind: RememberedSecretKind, secretId?: string): Promise<string> {
      const reply = await plugin.rememberSecret({
        secret,
        kind,
        ...(secretId === undefined ? {} : { secretId }),
      });
      const id = isRecord(reply) ? reply.secretId : undefined;
      if (!isUuidShapedId(id)) {
        throw new Error('The Android key vault returned an invalid remembered secret id.');
      }
      return id;
    },

    async resolve(secretId: string): Promise<string | null> {
      try {
        const reply = await plugin.resolveSecret({ secretId });
        const secret = isRecord(reply) ? reply.secret : undefined;
        return typeof secret === 'string' && secret.length > 0 ? secret : null;
      } catch {
        return null;
      }
    },

    async forget(secretId: string): Promise<void> {
      const reply = await plugin.forgetSecret({ secretId });
      if (!isRecord(reply) || typeof reply.deleted !== 'boolean') {
        throw new Error('The Android key vault returned an invalid remembered secret reply.');
      }
    },
  };
}

/** The registered `SshKeyVault` plugin carries the remembered-secret methods. */
export const rememberedSecrets = createRememberedSecrets(
  sshKeyVault as unknown as NativeRememberedSecretsPlugin,
);
