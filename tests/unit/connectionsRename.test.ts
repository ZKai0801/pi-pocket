import { describe, expect, it, vi } from 'vitest';
import { createConnectionsStore } from '../../src/stores/connections';

const kai = { name: 'kai', hostname: '192.168.1.3', port: 22, user: 'kai', keyHandleId: 'h-1' };
const other = { name: 'other', hostname: '10.0.0.9', port: 22, user: 'root', keyHandleId: 'h-2' };

function deps() {
  const hosts = {
    savedHosts: () => [kai, other],
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

describe('connections store host rename', () => {
  it('keeps the renamed active host active and drops the old row', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    store.save({ ...kai, name: 'kai-2' }, 'kai');
    expect(d.hosts.remove).toHaveBeenCalledWith('kai');
    expect(d.hosts.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'kai-2' }));
    expect(store.activeName).toBe('kai-2');
    expect(store.statusFor('kai-2')).toBe('connected');
  });

  it('renames an idle host without moving the active one', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    store.save({ ...other, name: 'other-2' }, 'other');
    expect(d.hosts.remove).toHaveBeenCalledWith('other');
    expect(store.activeName).toBe('kai');
  });
});
