import { describe, expect, it, vi } from 'vitest';
import type { SshCredential, SshHostTarget } from '@pocketshell/core';
import { createConnectionsStore } from '../../src/stores/connections';
import type { ConnectionPort } from '../../src/session/connectionPort';
import type { SavedHost } from '../../src/platform/android/hostStore';
import type { RememberedSecretKind, RememberedSecrets } from '../../src/native/rememberedSecrets';

const keyHost: SavedHost = {
  name: 'keyed', hostname: 'h', port: 22, user: 'u', keyHandleId: 'h-1',
  auth: { kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1' },
};

const passwordHost: SavedHost = {
  name: 'pw', hostname: 'h', port: 22, user: 'u', keyHandleId: '',
  auth: { kind: 'password', passwordCredentialId: 's-2' },
};

function deps(hosts: SavedHost[], secretsById: Record<string, string> = { 's-1': 'pass-1', 's-2': 'pw-2' }) {
  const save = vi.fn<(host: SavedHost) => void>();
  const remove = vi.fn<(name: string) => void>();
  const resolve = vi.fn(async (
    request: { host: string; port?: number; user: string; hostAlias?: string },
    credential?: SshCredential,
  ): Promise<SshHostTarget> => ({
    hostId: `${request.user}@${request.host}:${request.port ?? 22}`,
    hostname: request.host,
    port: request.port ?? 22,
    username: request.user,
    credential: credential ?? { kind: 'key-handle', handleId: 'h-1', passphrase: null },
  }));
  const connect = vi.fn(async (_target: SshHostTarget) => ({ ok: true }));
  const disconnect = vi.fn(async () => {});
  const port = { connect, disconnect } as ConnectionPort;
  const resolveSecret = vi.fn(async (secretId: string) => secretsById[secretId] ?? null);
  const put = vi.fn(async (_secret: string, _kind: RememberedSecretKind, _secretId?: string) => 's-9');
  const forget = vi.fn(async (_secretId: string) => {});
  const secrets: RememberedSecrets = { resolve: resolveSecret, put, forget };
  const hosts_ = { savedHosts: () => hosts, save, remove, resolve };
  return { hosts: hosts_, port, secrets, save, remove, resolve, connect, disconnect, put, forget, resolveSecret };
}

describe('connections store credentials', () => {
  it('dials with the remembered key passphrase', async () => {
    const d = deps([keyHost]);
    const store = createConnectionsStore(d);
    store.load();
    await store.connect('keyed');
    expect(d.resolveSecret).toHaveBeenCalledWith('s-1');
    expect(d.resolve).toHaveBeenCalledWith(
      { host: 'h', port: 22, user: 'u', hostAlias: 'keyed' },
      { kind: 'key-handle', handleId: 'h-1', passphrase: 'pass-1' },
    );
    expect(d.connect).toHaveBeenCalledWith(
      expect.objectContaining({ credential: { kind: 'key-handle', handleId: 'h-1', passphrase: 'pass-1' } }),
    );
  });

  it('dials a password host with the sealed password', async () => {
    const d = deps([passwordHost]);
    const store = createConnectionsStore(d);
    store.load();
    await store.connect('pw');
    expect(d.resolveSecret).toHaveBeenCalledWith('s-2');
    expect(d.connect).toHaveBeenCalledWith(
      expect.objectContaining({ credential: { kind: 'password', password: 'pw-2' } }),
    );
    expect(store.status).toBe('connected');
  });

  it('reports a missing saved password instead of dialling', async () => {
    const d = deps([passwordHost], {});
    const store = createConnectionsStore(d);
    store.load();
    await store.connect('pw');
    expect(store.status).toBe('error');
    expect(store.lastError).toMatch(/password/i);
    expect(d.connect).not.toHaveBeenCalled();
    expect(d.resolve).not.toHaveBeenCalled();
  });

  it('sends no passphrase and reads no secret when remembering is off', async () => {
    const d = deps([{
      ...keyHost,
      auth: { kind: 'key', keyHandleId: 'h-1', rememberPassphrase: false, secretId: 's-1' },
    }]);
    const store = createConnectionsStore(d);
    store.load();
    await store.connect('keyed');
    expect(d.resolveSecret).not.toHaveBeenCalled();
    expect(d.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ hostAlias: 'keyed' }),
      { kind: 'key-handle', handleId: 'h-1', passphrase: null },
    );
  });

  it('forgets the previous secret when a save stops referencing it', async () => {
    const d = deps([keyHost]);
    const store = createConnectionsStore(d);
    store.load();
    await store.save({
      ...keyHost,
      auth: { kind: 'key', keyHandleId: 'h-1', rememberPassphrase: false },
    });
    expect(d.save).toHaveBeenCalled();
    expect(d.forget).toHaveBeenCalledWith('s-1');
  });

  it('keeps a secret the new record still references', async () => {
    const d = deps([keyHost]);
    const store = createConnectionsStore(d);
    store.load();
    await store.save({ ...keyHost });
    expect(d.save).toHaveBeenCalled();
    expect(d.forget).not.toHaveBeenCalled();
  });

  it('keeps the remembered secret when the host is renamed', async () => {
    const d = deps([keyHost]);
    const store = createConnectionsStore(d);
    store.load();
    await store.save({ ...keyHost, name: 'keyed-2' }, 'keyed');
    expect(d.remove).toHaveBeenCalledWith('keyed');
    expect(d.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'keyed-2',
        auth: expect.objectContaining({ secretId: 's-1', rememberPassphrase: true }),
      }),
    );
    expect(d.forget).not.toHaveBeenCalled();
  });

  it('remove forgets every remembered secret the record held', async () => {
    const d = deps([keyHost, passwordHost]);
    const store = createConnectionsStore(d);
    store.load();
    await store.remove('keyed');
    await store.remove('pw');
    expect(d.forget).toHaveBeenCalledWith('s-1');
    expect(d.forget).toHaveBeenCalledWith('s-2');
  });

  it('saveSecret seals a key passphrase and writes its id', async () => {
    const d = deps([keyHost]);
    const store = createConnectionsStore(d);
    store.load();
    await store.saveSecret(keyHost, 'fresh-pass');
    expect(d.put).toHaveBeenCalledWith('fresh-pass', 'key-passphrase');
    const written = d.save.mock.calls[0]![0];
    expect(written.auth).toEqual({
      kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-9',
    });
    expect(JSON.stringify(written)).not.toContain('fresh-pass');
    expect(d.forget).toHaveBeenCalledWith('s-1');
  });

  it('saveSecret seals a password and writes its id', async () => {
    const d = deps([passwordHost]);
    const store = createConnectionsStore(d);
    store.load();
    await store.saveSecret(passwordHost, 'fresh-pw');
    expect(d.put).toHaveBeenCalledWith('fresh-pw', 'password');
    const written = d.save.mock.calls[0]![0];
    expect(written.auth).toEqual({ kind: 'password', passwordCredentialId: 's-9' });
    expect(JSON.stringify(written)).not.toContain('fresh-pw');
    expect(d.forget).toHaveBeenCalledWith('s-2');
  });

  it('save seals a supplied secret before writing the record', async () => {
    const d = deps([keyHost]);
    const store = createConnectionsStore(d);
    store.load();
    await store.save({ ...keyHost }, null, 'new-pass');
    expect(d.put).toHaveBeenCalledWith('new-pass', 'key-passphrase');
    expect(d.save).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ secretId: 's-9' }) }),
    );
    expect(d.forget).toHaveBeenCalledWith('s-1');
  });

  it('a failing forget never blocks a save or a remove', async () => {
    const d = deps([keyHost]);
    d.forget.mockRejectedValue(new Error('keystore reset'));
    const store = createConnectionsStore(d);
    store.load();
    await expect(store.save({
      ...keyHost,
      auth: { kind: 'key', keyHandleId: 'h-1', rememberPassphrase: false },
    })).resolves.toBeUndefined();
    expect(d.save).toHaveBeenCalled();
    await expect(store.remove('keyed')).resolves.toBeUndefined();
    expect(d.remove).toHaveBeenCalledWith('keyed');
  });

  it('forgetSecrets clears the stored ids and rewrites the record', async () => {
    const d = deps([keyHost, passwordHost]);
    const store = createConnectionsStore(d);
    store.load();
    await store.forgetSecrets('keyed');
    await store.forgetSecrets('pw');
    expect(d.forget).toHaveBeenCalledWith('s-1');
    expect(d.forget).toHaveBeenCalledWith('s-2');
    expect(d.save).toHaveBeenCalledWith({
      ...keyHost,
      auth: { kind: 'key', keyHandleId: 'h-1' },
    });
    expect(d.save).toHaveBeenCalledWith({
      ...passwordHost,
      auth: { kind: 'password', passwordCredentialId: '' },
    });
  });
});
