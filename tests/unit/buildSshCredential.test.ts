import { describe, expect, it, vi } from 'vitest';
import { buildSshCredential, UnsupportedHostAuth } from '../../src/credentials/buildSshCredential';
import type { HostAuth } from '../../src/platform/android/hostStore';

describe('buildSshCredential', () => {
  it('returns a bare key-handle when nothing is remembered', async () => {
    const c = await buildSshCredential({ kind: 'key', keyHandleId: 'h-1', rememberPassphrase: false }, vi.fn());
    expect(c).toEqual({ kind: 'key-handle', handleId: 'h-1', passphrase: null });
  });

  it('attaches the remembered passphrase', async () => {
    const lookup = vi.fn(async () => 'hunter2');
    const c = await buildSshCredential({ kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1' }, lookup);
    expect(c).toEqual({ kind: 'key-handle', handleId: 'h-1', passphrase: 'hunter2' });
  });

  it('does not send a passphrase when the remembered secret is gone', async () => {
    const c = await buildSshCredential({ kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1' }, vi.fn(async () => null));
    expect(c).toEqual({ kind: 'key-handle', handleId: 'h-1', passphrase: null });
  });

  it('builds a password credential from the store', async () => {
    const c = await buildSshCredential({ kind: 'password', passwordCredentialId: 's-2' }, vi.fn(async () => 'pw'));
    expect(c).toEqual({ kind: 'password', password: 'pw' });
  });

  it('refuses to build a password credential without a stored password', async () => {
    await expect(buildSshCredential({ kind: 'password', passwordCredentialId: 's-2' }, vi.fn(async () => null)))
      .rejects.toThrow(/password/i);
  });

  it('treats an undecryptable secret as absent', async () => {
    const lookup = vi.fn(async () => { throw new Error('keystore reset'); });
    const c = await buildSshCredential({ kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1' }, lookup);
    expect(c).toEqual({ kind: 'key-handle', handleId: 'h-1', passphrase: null });
  });

  it('does not call lookup when the key passphrase is not remembered', async () => {
    const lookup = vi.fn(async () => 'hunter2');
    await buildSshCredential({ kind: 'key', keyHandleId: 'h-1', rememberPassphrase: false }, lookup);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not look up a stale secret id when remembering is off', async () => {
    const lookup = vi.fn(async () => 'hunter2');
    const c = await buildSshCredential({ kind: 'key', keyHandleId: 'h-1', rememberPassphrase: false, secretId: 's-1' }, lookup);
    expect(lookup).not.toHaveBeenCalled();
    expect(c).toEqual({ kind: 'key-handle', handleId: 'h-1', passphrase: null });
  });

  it('rejects a password lookup that throws', async () => {
    const lookup = vi.fn(async () => { throw new Error('keystore reset'); });
    await expect(buildSshCredential({ kind: 'password', passwordCredentialId: 's-2' }, lookup))
      .rejects.toThrow(/password/i);
  });

  it('rejects an unknown auth kind without touching the lookup', async () => {
    const lookup = vi.fn(async () => 'secret');
    await expect(buildSshCredential({ kind: 'agent' } as unknown as HostAuth, lookup))
      .rejects.toBeInstanceOf(UnsupportedHostAuth);
    expect(lookup).not.toHaveBeenCalled();
  });
});
