import { describe, expect, it } from 'vitest';
import { AndroidHostStore, validateSavedHost, type SavedHost } from '../../src/platform/android/hostStore';

function make(seed?: string) {
  const map = new Map<string, string>();
  if (seed) map.set('pocketshell.android.hosts.v1', seed);
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
  return new AndroidHostStore({ storage, readLegacyHosts: async () => [] });
}

describe('SavedHost auth', () => {
  it('loads a v1 record with no auth as a key host', () => {
    const seed = JSON.stringify([
      { name: 'kai', hostname: 'h', port: 22, user: 'kai', keyHandleId: 'h-1' },
    ]);
    expect(make(seed).savedHosts()).toEqual([
      { name: 'kai', hostname: 'h', port: 22, user: 'kai', keyHandleId: 'h-1' },
    ]);
  });

  it('round-trips a password host under the same storage key', () => {
    const store = make();
    const host: SavedHost = { name: 'p', hostname: 'h', port: 22, user: 'u', keyHandleId: '',
      auth: { kind: 'password', passwordCredentialId: 's-1' } };
    expect(validateSavedHost(host)).toBeNull();
    store.save(host);
    expect(store.savedHosts()[0]!.auth).toEqual({ kind: 'password', passwordCredentialId: 's-1' });
  });

  it('still requires a key for a key host', () => {
    expect(validateSavedHost({ name: 'k', hostname: 'h', port: 22, user: 'u', keyHandleId: '' }))
      .toMatch(/key/i);
  });

  it('keeps piSessionsDir and piCommand through a save', () => {
    const store = make();
    store.save({ name: 'k', hostname: 'h', port: 22, user: 'u', keyHandleId: 'h-1',
      piSessionsDir: '/home/projects/.pi-agent/sessions', piCommand: '/opt/bin/pi' });
    expect(store.savedHosts()[0]).toMatchObject({
      piSessionsDir: '/home/projects/.pi-agent/sessions', piCommand: '/opt/bin/pi',
    });
  });

  it('loads a key auth record saved before remember fields existed', () => {
    const seed = JSON.stringify([{ name: 'kai', hostname: 'h', port: 22, user: 'kai', keyHandleId: 'h-1',
      auth: { kind: 'key', keyHandleId: 'h-1' } }]);
    expect(make(seed).savedHosts()[0]!.auth).toEqual({ kind: 'key', keyHandleId: 'h-1' });
  });

  it('round-trips rememberPassphrase and secretId through a save', () => {
    const store = make();
    const host: SavedHost = { name: 'k', hostname: 'h', port: 22, user: 'u', keyHandleId: 'h-1',
      auth: { kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1' } };
    store.save(host);
    expect(store.savedHosts()[0]!.auth).toEqual({
      kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1',
    });
  });

  it('drops a key auth with a malformed remember flag or secret id', () => {
    const seed = JSON.stringify([
      { name: 'a', hostname: 'h', port: 22, user: 'u', keyHandleId: 'h-1',
        auth: { kind: 'key', keyHandleId: 'h-1', rememberPassphrase: 'yes' } },
      { name: 'b', hostname: 'h', port: 22, user: 'u', keyHandleId: 'h-2',
        auth: { kind: 'key', keyHandleId: 'h-2', rememberPassphrase: true, secretId: '' } },
    ]);
    expect(make(seed).savedHosts()).toEqual([]);
  });

  it('refuses to dial a password host until Plan 4 wires the secret', async () => {
    const seed = JSON.stringify([{ name: 'p', hostname: 'h', port: 22, user: 'u', keyHandleId: '',
      auth: { kind: 'password', passwordCredentialId: 's-1' } }]);
    await expect(make(seed).resolve({ host: 'h', user: 'u', hostAlias: 'p' }))
      .rejects.toThrow(/password|credential/i);
  });
});
