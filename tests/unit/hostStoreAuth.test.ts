import { describe, expect, it } from 'vitest';
import { AndroidHostStore, savedHostProblem, validateSavedHost, type SavedHost } from '../../src/platform/android/hostStore';

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

  it('names each problem as a code while keeping the shared English sentence byte-identical (R35)', () => {
    // The five sentences are a public contract pinned here byte-for-byte: a
    // translation of the wrapper would turn this test red, which is the point.
    const complete: SavedHost = { name: 'k', hostname: 'h', port: 22, user: 'u', keyHandleId: 'h-1' };
    const cases: Array<[SavedHost, string, string]> = [
      [{ ...complete, name: '  ' }, 'name', 'Give the host a name.'],
      [{ ...complete, hostname: '' }, 'hostname', 'Enter a hostname or IP address.'],
      [{ ...complete, user: '' }, 'user', 'Enter the SSH user.'],
      [{ ...complete, port: 0 }, 'port', 'Port must be 1–65535.'],
      [{ ...complete, port: 70000 }, 'port', 'Port must be 1–65535.'],
      [{ ...complete, keyHandleId: '' }, 'key', 'Choose an SSH key from the key vault.'],
    ];
    for (const [host, code, sentence] of cases) {
      expect(savedHostProblem(host), sentence).toBe(code);
      expect(validateSavedHost(host), sentence).toBe(sentence);
    }
    // The first failing field wins, in the order the sentences have always used.
    expect(validateSavedHost({ name: '', hostname: '', port: 0, user: '', keyHandleId: '' }))
      .toBe('Give the host a name.');
    // A password host needs no key; a complete record has no problem either way.
    const password = { ...complete, keyHandleId: '', auth: { kind: 'password' as const, passwordCredentialId: 'p-1' } };
    expect(savedHostProblem(password)).toBeNull();
    expect(validateSavedHost(password)).toBeNull();
    expect(savedHostProblem(complete)).toBeNull();
    expect(validateSavedHost(complete)).toBeNull();
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

  it('dials a password host with a supplied credential', async () => {
    const seed = JSON.stringify([{ name: 'p', hostname: 'h', port: 22, user: 'u', keyHandleId: '',
      auth: { kind: 'password', passwordCredentialId: 's-1' } }]);
    const credential = { kind: 'password' as const, password: 'pw' };
    const target = await make(seed).resolve({ host: 'h', user: 'u', hostAlias: 'p' }, credential);
    expect(target).toEqual({
      hostId: 'u@h:22', hostname: 'h', port: 22, username: 'u', credential,
    });
  });

  it('dials a key host with no handle when a supplied credential replaces it', async () => {
    const seed = JSON.stringify([{ name: 'k', hostname: 'h', port: 22, user: 'u', keyHandleId: '',
      auth: { kind: 'key', keyHandleId: '' } }]);
    const credential = { kind: 'key-handle' as const, handleId: 'h-9', passphrase: null };
    const target = await make(seed).resolve({ host: 'h', user: 'u', hostAlias: 'k' }, credential);
    expect(target.credential).toEqual(credential);
  });

  it('still refuses a key host with no handle and no credential', async () => {
    const seed = JSON.stringify([{ name: 'k', hostname: 'h', port: 22, user: 'u', keyHandleId: '' }]);
    await expect(make(seed).resolve({ host: 'h', user: 'u', hostAlias: 'k' }))
      .rejects.toThrow(/SSH key/i);
  });
});
