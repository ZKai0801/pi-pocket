import { describe, expect, it, vi } from 'vitest';
import { createRememberedSecrets, type NativeRememberedSecretsPlugin } from '../../src/native/rememberedSecrets';

const SECRET_ID = 'de7de7de-0000-4000-8000-000000000001';

function plugin(overrides: Partial<NativeRememberedSecretsPlugin> = {}): NativeRememberedSecretsPlugin {
  return {
    rememberSecret: vi.fn(),
    resolveSecret: vi.fn(),
    forgetSecret: vi.fn(),
    ...overrides,
  } as never;
}

describe('rememberedSecrets', () => {
  it('returns the id the native store handed back', async () => {
    const native = plugin({ rememberSecret: vi.fn(async () => ({ secretId: SECRET_ID })) });
    const store = createRememberedSecrets(native);
    expect(await store.put('pw', 'password')).toBe(SECRET_ID);
  });

  it('rejects a reply that is not a UUID-shaped id', async () => {
    const native = plugin({ rememberSecret: vi.fn(async () => ({ secretId: 'nope' })) });
    const store = createRememberedSecrets(native);
    await expect(store.put('pw', 'password')).rejects.toThrow();
  });

  it('resolves null when the bridge rejects a lookup', async () => {
    const native = plugin({ resolveSecret: vi.fn(async () => { throw new Error('unknown'); }) });
    const store = createRememberedSecrets(native);
    expect(await store.resolve(SECRET_ID)).toBeNull();
  });

  it('returns a resolved secret verbatim', async () => {
    const native = plugin({ resolveSecret: vi.fn(async () => ({ secret: 'pw' })) });
    const store = createRememberedSecrets(native);
    expect(await store.resolve(SECRET_ID)).toBe('pw');
  });

  it('put forwards the kind and omits secretId when it was not given', async () => {
    const rememberSecret = vi.fn(async (_options: Record<string, unknown>) => ({ secretId: SECRET_ID }));
    const store = createRememberedSecrets(plugin({ rememberSecret }));
    await store.put('pw', 'key-passphrase');
    const request = rememberSecret.mock.calls[0][0];
    expect(request).toEqual({ secret: 'pw', kind: 'key-passphrase' });
    expect(Object.keys(request)).toEqual(['secret', 'kind']);
  });

  it('put forwards an existing secretId', async () => {
    const rememberSecret = vi.fn(async (_options: Record<string, unknown>) => ({ secretId: SECRET_ID }));
    const store = createRememberedSecrets(plugin({ rememberSecret }));
    expect(await store.put('pw', 'password', SECRET_ID)).toBe(SECRET_ID);
    expect(rememberSecret).toHaveBeenCalledWith({ secret: 'pw', kind: 'password', secretId: SECRET_ID });
  });

  it('resolves null for a missing secret', async () => {
    const native = plugin({ resolveSecret: vi.fn(async () => ({ secret: null })) });
    const store = createRememberedSecrets(native);
    expect(await store.resolve(SECRET_ID)).toBeNull();
  });

  it('resolves null for an empty-string secret instead of returning an empty password', async () => {
    const native = plugin({ resolveSecret: vi.fn(async () => ({ secret: '' })) });
    const store = createRememberedSecrets(native);
    expect(await store.resolve(SECRET_ID)).toBeNull();
  });

  it('forget calls the plugin with the id and resolves on deleted:false', async () => {
    const forgetSecret = vi.fn(async () => ({ deleted: false }));
    const store = createRememberedSecrets(plugin({ forgetSecret }));
    await expect(store.forget(SECRET_ID)).resolves.toBeUndefined();
    expect(forgetSecret).toHaveBeenCalledWith({ secretId: SECRET_ID });
  });

  it('forget rejects only when the bridge fails', async () => {
    const native = plugin({ forgetSecret: vi.fn(async () => { throw new Error('bridge down'); }) });
    const store = createRememberedSecrets(native);
    await expect(store.forget(SECRET_ID)).rejects.toThrow('bridge down');
  });

  it('passes the secret to the store without logging it', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
    try {
      const rememberSecret = vi.fn(async () => ({ secretId: SECRET_ID }));
      const store = createRememberedSecrets(plugin({ rememberSecret }));
      await store.put('hunter2', 'password');
      expect(rememberSecret).toHaveBeenCalledWith({ secret: 'hunter2', kind: 'password' });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
