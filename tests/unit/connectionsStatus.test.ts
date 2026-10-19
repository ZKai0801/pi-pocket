import { describe, expect, it, vi } from 'vitest';
import { createConnectionSnapshotSync } from '../../src/phone/connectionSnapshot';
import { createConnectionsStore } from '../../src/stores/connections';

const kai = { name: 'kai', hostname: '192.168.1.3', port: 22, user: 'kai', keyHandleId: 'h-1' };

function deps() {
  const hosts = {
    savedHosts: () => [kai],
    save: vi.fn(),
    remove: vi.fn(),
    resolve: vi.fn(async () => ({
      hostId: 'kai@192.168.1.3:22',
      hostname: '192.168.1.3', port: 22, username: 'kai',
      credential: { kind: 'key-handle', handleId: 'h-1' },
    })),
  };
  const port = { connect: vi.fn(async () => ({ ok: true })), disconnect: vi.fn(async () => {}) };
  return { hosts, port };
}

describe('connections store live status', () => {
  it('flips the active host off when a controller snapshot leaves the connected phase', async () => {
    const store = createConnectionsStore(deps() as never);
    await store.connect('kai');
    expect(store.statusFor('kai')).toBe('connected');

    store.applyConnectionSnapshot('reconnecting');
    expect(store.status).toBe('connecting');
    expect(store.statusFor('kai')).toBe('idle');

    store.applyConnectionSnapshot('live');
    expect(store.statusFor('kai')).toBe('connected');
  });

  it('reports a lost connection as error, not connected', async () => {
    const store = createConnectionsStore(deps() as never);
    await store.connect('kai');
    store.applyConnectionSnapshot('lost');
    expect(store.status).toBe('error');
    expect(store.statusFor('kai')).toBe('idle');
    expect(store.activeName).toBeNull();
  });

  it('forwards a controller snapshot to the local copy and the store', async () => {
    const store = createConnectionsStore(deps() as never);
    await store.connect('kai');
    const onSnapshot = vi.fn();
    const forward = createConnectionSnapshotSync({
      onSnapshot,
      apply: store.applyConnectionSnapshot,
    });

    forward({ phase: 'lost' });

    expect(onSnapshot).toHaveBeenCalledWith({ phase: 'lost' });
    expect(store.status).toBe('error');
    expect(store.activeName).toBeNull();
  });

  it('ignores a snapshot when no host is active', () => {
    const store = createConnectionsStore(deps() as never);
    store.applyConnectionSnapshot('error');
    expect(store.status).toBe('idle');
    expect(store.activeName).toBeNull();
  });
});
