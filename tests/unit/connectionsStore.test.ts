import { describe, expect, it, vi } from 'vitest';
import { createConnectionsStore } from '../../src/stores/connections';

const kai = { name: 'kai', hostname: '192.168.1.3', port: 22, user: 'kai', keyHandleId: 'h-1' };
const other = { name: 'other', hostname: '10.0.0.9', port: 22, user: 'root', keyHandleId: 'h-2' };

function deps(over: Record<string, unknown> = {}) {
  const hosts = {
    savedHosts: () => [kai, other],
    save: vi.fn(),
    remove: vi.fn(),
    resolve: vi.fn(async (request: { hostAlias?: string }) => ({
      hostId: `${request.hostAlias}@192.168.1.3:22`,
      hostname: '192.168.1.3', port: 22, username: 'kai',
      credential: { kind: 'key-handle', handleId: 'h-1' },
    })),
  };
  const port = { connect: vi.fn(async () => ({ ok: true })), disconnect: vi.fn(async () => {}) };
  return { hosts, port, ...over };
}

describe('connections store', () => {
  it('loads the saved hosts, none of them connected', () => {
    const store = createConnectionsStore(deps() as never);
    store.load();
    expect(store.hosts).toHaveLength(2);
    expect(store.statusFor('kai')).toBe('idle');
    expect(store.status).toBe('idle');
  });

  it('only the active host reports connected', async () => {
    const store = createConnectionsStore(deps() as never);
    await store.connect('kai');
    expect(store.statusFor('kai')).toBe('connected');
    expect(store.statusFor('other')).toBe('idle');
  });

  it('dials the resolved target, not the raw record', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    expect(d.hosts.resolve).toHaveBeenCalledWith(
      { host: '192.168.1.3', port: 22, user: 'kai', hostAlias: 'kai' },
      { kind: 'key-handle', handleId: 'h-1', passphrase: null },
    );
    expect(d.port.connect).toHaveBeenCalledWith(
      expect.objectContaining({ credential: { kind: 'key-handle', handleId: 'h-1' } }),
    );
  });

  it('closes the current connection before opening another (D8)', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    await store.connect('other');
    expect(d.port.disconnect).toHaveBeenCalledTimes(1);
    expect(store.activeName).toBe('other');
    expect(store.statusFor('kai')).toBe('idle');
  });

  it('surfaces a dial failure as error status, not a throw', async () => {
    const d = deps();
    d.port.connect = vi.fn(async () => { throw new Error('auth failed'); });
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    expect(store.status).toBe('error');
    expect(store.lastError).toContain('auth failed');
    expect(store.activeName).toBeNull();
  });

  it('reports a missing credential instead of dialling', async () => {
    const d = deps();
    d.hosts.resolve = vi.fn(async () => { throw new Error('No SSH key is chosen'); });
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    expect(store.status).toBe('error');
    expect(d.port.connect).not.toHaveBeenCalled();
  });

  it('saves and removes through the host store, closing a removed live host (D8)', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    store.save({ ...kai, name: 'renamed' });
    expect(d.hosts.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'renamed' }));
    await store.remove('kai');
    expect(d.hosts.remove).toHaveBeenCalledWith('kai');
    expect(d.port.disconnect).toHaveBeenCalledTimes(1);
    expect(store.activeName).toBeNull();
  });

  it('treats a resolved { ok: false } dial as a failure, not a connection (D8)', async () => {
    const d = deps();
    d.port.connect = vi.fn(async () => ({ ok: false }));
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    expect(store.status).toBe('error');
    expect(store.activeName).toBeNull();
    expect(store.lastError).toBeTruthy();
  });

  it('leaves a live connection alone when the named host is unknown (D8)', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    await store.connect('ghost');
    expect(store.activeName).toBe('kai');
    expect(store.statusFor('kai')).toBe('connected');
    expect(d.port.disconnect).not.toHaveBeenCalled();
    expect(d.port.connect).toHaveBeenCalledTimes(1);
    expect(store.lastError).toContain('ghost');
  });

  it('does not dial twice when connect() is re-entered (D8 interleaving)', async () => {
    const d = deps();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    d.port.connect = vi.fn(async () => { await gate; return { ok: true }; });
    const store = createConnectionsStore(d as never);
    const first = store.connect('kai');
    const second = store.connect('other');
    release();
    await Promise.all([first, second]);
    expect(d.port.connect).toHaveBeenCalledTimes(1);
    expect(store.activeName).toBe('kai');
  });
});
