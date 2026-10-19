import { describe, expect, it, vi } from 'vitest';
import { createConnectionsStore } from '../../src/stores/connections';
import { createProjectsStore } from '../../src/stores/projects';

const kai = { name: 'kai', hostname: '192.168.1.3', port: 22, user: 'kai', keyHandleId: 'h-1' };
const pi = { name: 'pi', hostname: '10.0.0.9', port: 22, user: 'kai', keyHandleId: 'h-2', piSessionsDir: '/old' };

function deps() {
  const hosts = {
    savedHosts: () => [kai, pi],
    save: vi.fn(),
    remove: vi.fn(),
    resolve: vi.fn(),
  };
  const port = { connect: vi.fn(async () => ({ ok: true })), disconnect: vi.fn(async () => {}) };
  return { hosts, port };
}

describe('projects no-root Pi sessions directory action', () => {
  it('persists a per-host Pi sessions directory override', () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    store.load();
    store.setPiSessionsDir('kai', '  /home/projects/.pi-agent/sessions  ');
    expect(d.hosts.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'kai', piSessionsDir: '/home/projects/.pi-agent/sessions' }),
    );
  });

  it('clears the override when the field is left blank', () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    store.load();
    store.setPiSessionsDir('pi', '   ');
    const saved = d.hosts.save.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.name).toBe('pi');
    expect('piSessionsDir' in saved).toBe(false);
  });

  it('saves the no-root directory and re-probes through the projects store', async () => {
    const setPiSessionsDir = vi.fn();
    const listProjects = vi.fn(async () => [{ path: '/p/a', name: 'a' }]);
    const store = createProjectsStore({
      resolveRoot: async () => '/root',
      listProjects,
      setPiSessionsDir,
    });

    await store.discover();
    expect(listProjects).toHaveBeenCalledTimes(1);

    await store.savePiSessionsDir('kai', '  /home/projects/.pi-agent/sessions  ');

    expect(setPiSessionsDir).toHaveBeenCalledWith(
      'kai',
      '  /home/projects/.pi-agent/sessions  ',
    );
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(store.state).toBe('ready');
    expect(store.projects).toEqual([{ path: '/p/a', name: 'a' }]);
  });
});
