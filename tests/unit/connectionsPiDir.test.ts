import { describe, expect, it, vi } from 'vitest';
import { createConnectionsStore } from '../../src/stores/connections';
import projectsListSource from '../../src/components/projects/ProjectsList.vue?raw';

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

  it('exposes the no-root directory action and re-probes after saving', () => {
    expect(projectsListSource).toContain('setPiSessionsDir');
    expect(projectsListSource).toContain('data-testid="projects-pi-dir-save"');
    expect(projectsListSource).toContain('store.discover');
  });
});
