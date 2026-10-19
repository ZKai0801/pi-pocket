import { describe, expect, it, vi } from 'vitest';
import { createConnectionsStore } from '../../src/stores/connections';

const kai = { name: 'kai', hostname: '192.168.1.3', port: 22, user: 'kai', keyHandleId: 'h-1' };
const other = { name: 'other', hostname: '10.0.0.9', port: 22, user: 'root', keyHandleId: 'h-2' };

function deps() {
  const hosts = {
    savedHosts: () => [kai, other],
    save: vi.fn(),
    remove: vi.fn(),
    resolve: vi.fn(async (request: { hostAlias?: string }) => ({
      hostId: `${request.hostAlias}@x:22`,
      hostname: 'x', port: 22, username: 'kai',
      credential: { kind: 'key-handle', handleId: 'h-1' },
    })),
  };
  const port = { connect: vi.fn(async () => ({ ok: true })), disconnect: vi.fn(async () => {}) };
  return { hosts, port };
}

describe('connections store host switch confirmation', () => {
  it('keeps the live connection when the switch confirm is refused', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    await store.requestConnect('other');
    expect(store.pendingSwitch).toBe('other');
    expect(store.activeName).toBe('kai');
    expect(store.statusFor('kai')).toBe('connected');
    expect(d.port.disconnect).not.toHaveBeenCalled();

    store.cancelSwitch();
    expect(store.pendingSwitch).toBeNull();
    expect(store.activeName).toBe('kai');
    expect(d.port.connect).toHaveBeenCalledTimes(1);
  });

  it('closes the current host only after the switch is confirmed', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    await store.requestConnect('other');
    await store.confirmSwitch();
    expect(d.port.disconnect).toHaveBeenCalledTimes(1);
    expect(store.activeName).toBe('other');
    expect(store.pendingSwitch).toBeNull();
  });

  it('connects directly when nothing is live or the host is already active', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.requestConnect('kai');
    expect(store.pendingSwitch).toBeNull();
    expect(store.activeName).toBe('kai');

    await store.requestConnect('kai');
    expect(store.pendingSwitch).toBeNull();
    expect(d.port.connect).toHaveBeenCalledTimes(1);
  });

  it('reconnects a dropped host without asking to switch', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    store.applyConnectionSnapshot('lost');
    expect(store.activeName).toBeNull();

    await store.requestConnect('kai');
    expect(store.pendingSwitch).toBeNull();
    expect(d.port.disconnect).not.toHaveBeenCalled();
    expect(d.port.connect).toHaveBeenCalledTimes(2);
    expect(store.statusFor('kai')).toBe('connected');
  });

  it('does not ask to switch after the live connection is lost', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    store.applyConnectionSnapshot('lost');

    await store.requestConnect('other');
    expect(store.pendingSwitch).toBeNull();
    expect(store.activeName).toBe('other');
    expect(d.port.connect).toHaveBeenCalledTimes(2);
  });
});
