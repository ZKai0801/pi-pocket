// tests/unit/projectsStore.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createProjectsStore } from '../../src/stores/projects';

const deps = (over: Partial<Record<string, unknown>> = {}) => ({
  resolveRoot: vi.fn(async () => '/root'),
  listProjects: vi.fn(async () => [{ path: '/home/kai', name: 'kai' }]),
  ...over,
});

describe('projects store', () => {
  it('loads the discovered projects', async () => {
    const store = createProjectsStore(deps() as never);
    await store.discover();
    expect(store.state).toBe('ready');
    expect(store.projects).toEqual([{ path: '/home/kai', name: 'kai' }]);
  });

  it('reports no-root when the probe finds nothing', async () => {
    const store = createProjectsStore(deps({ resolveRoot: vi.fn(async () => null) }) as never);
    await store.discover();
    expect(store.state).toBe('no-root');
  });

  it('reports error, not an empty list, when discovery fails', async () => {
    const store = createProjectsStore(deps({ listProjects: vi.fn(async () => { throw new Error('exec 255'); }) }) as never);
    await store.discover();
    expect(store.state).toBe('error');
    expect(store.error).toContain('exec 255');
    expect(store.projects).toEqual([]);
  });

  it('filters by path and name case-insensitively', async () => {
    const store = createProjectsStore(deps({ listProjects: vi.fn(async () => [
      { path: '/home/kai', name: 'kai' }, { path: '/home/projects/auto_sci', name: 'auto_sci' }]) }) as never);
    await store.discover();
    store.setQuery('SCI');
    expect(store.filtered.map((p) => p.name)).toEqual(['auto_sci']);
  });

  it('lists an added project before it has any session', async () => {
    const store = createProjectsStore(deps({ listProjects: vi.fn(async () => []) }) as never);
    await store.discover();
    store.addProject('/home/projects/new');
    expect(store.filtered.map((p) => p.name)).toEqual(['new']);
  });

  it('lists the projects against the resolved root, not a fixed one', async () => {
    const listProjects = vi.fn(async (root: string) => [{ path: `${root}/kai`, name: 'kai' }]);
    const store = createProjectsStore({
      resolveRoot: vi.fn(async () => '/root'),
      listProjects,
    } as never);
    await store.discover();
    expect(listProjects).toHaveBeenCalledWith('/root');
  });

  it('merges the added projects behind the discovered ones, de-duped by path', async () => {
    const added = {
      load: vi.fn(async () => ['/home/kai', '/home/extra']),
      save: vi.fn(async () => undefined),
    };
    const store = createProjectsStore(deps({ added }) as never);
    await store.discover();
    expect(store.projects.map((p) => p.path)).toEqual(['/home/kai', '/home/extra']);
    expect(store.projects.map((p) => p.name)).toEqual(['kai', 'extra']);
  });

  it('lists the added projects even when the probe finds no root', async () => {
    const added = { load: vi.fn(async () => ['/home/extra']), save: vi.fn(async () => undefined) };
    const store = createProjectsStore(deps({
      resolveRoot: vi.fn(async () => null),
      added,
    }) as never);
    await store.discover();
    expect(store.state).toBe('no-root');
    expect(store.projects.map((p) => p.name)).toEqual(['extra']);
  });

  it('degrades to an empty added list when the added load fails', async () => {
    const added = {
      load: vi.fn(async () => { throw new Error('storage unavailable'); }),
      save: vi.fn(async () => undefined),
    };
    const store = createProjectsStore(deps({ added }) as never);
    await store.discover();
    expect(store.state).toBe('ready');
    expect(store.projects).toEqual([{ path: '/home/kai', name: 'kai' }]);
  });

  it('reports the missing seam as an error, not a throw', async () => {
    const d = deps({
      resolveRoot: vi.fn(async () => { throw new Error('No live connection owner is installed yet.'); }),
    });
    const store = createProjectsStore(d as never);
    await store.discover();
    expect(store.state).toBe('error');
    expect(store.error).toContain('No live connection owner is installed yet.');
    expect(store.projects).toEqual([]);
  });

  it('persists the added list after a successful load', async () => {
    const added = { load: vi.fn(async () => []), save: vi.fn(async () => undefined) };
    const store = createProjectsStore(deps({ added }) as never);
    await store.discover();
    store.addProject('/home/projects/new');
    expect(added.save).toHaveBeenCalledWith(['/home/projects/new']);
  });

  it('never persists after a rejected added load, so a fresh list cannot erase the stored one', async () => {
    const added = {
      load: vi.fn(async () => { throw new Error('storage unavailable'); }),
      save: vi.fn(async () => undefined),
    };
    const store = createProjectsStore(deps({ added }) as never);
    await store.discover();
    store.addProject('/home/projects/new');
    expect(added.save).not.toHaveBeenCalled();
  });

  it('does not discover twice when discover() is re-entered', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const d = deps({ resolveRoot: vi.fn(async () => { await gate; return '/root'; }) });
    const store = createProjectsStore(d as never);
    const first = store.discover();
    const second = store.discover();
    release();
    await Promise.all([first, second]);
    expect(d.resolveRoot).toHaveBeenCalledTimes(1);
    expect(d.listProjects).toHaveBeenCalledTimes(1);
    expect(store.state).toBe('ready');
  });

  it('selects a project for the sessions tab', async () => {
    const store = createProjectsStore(deps() as never);
    await store.discover();
    expect(store.selected).toBeNull();
    store.select('/home/kai');
    expect(store.selected).toBe('/home/kai');
  });

  it('opens the directory browser at $HOME', async () => {
    const browse = {
      home: vi.fn(async () => '/home/kai'),
      listDirs: vi.fn(async () => [{ name: 'projects', path: '/home/kai/projects' }]),
    };
    const store = createProjectsStore(deps({ browse }) as never);
    await store.openBrowse();
    expect(store.browse.open).toBe(true);
    expect(store.browse.cwd).toBe('/home/kai');
    expect(store.browse.dirs).toEqual([{ name: 'projects', path: '/home/kai/projects' }]);
    expect(store.browse.error).toBeNull();
    expect(store.browse.busy).toBe(false);
    expect(browse.listDirs).toHaveBeenCalledWith('/home/kai');
  });

  it('enters a directory and moves up one, clamped at the browser root', async () => {
    const browse = {
      home: vi.fn(async () => '/home/kai'),
      listDirs: vi.fn(async (dir: string) =>
        dir === '/home/kai'
          ? [{ name: 'projects', path: '/home/kai/projects' }]
          : [{ name: 'new', path: '/home/kai/projects/new' }]),
    };
    const store = createProjectsStore(deps({ browse }) as never);
    await store.openBrowse();
    await store.browseEnter('/home/kai/projects');
    expect(store.browse.cwd).toBe('/home/kai/projects');
    expect(store.browse.dirs?.map((dir) => dir.name)).toEqual(['new']);
    await store.browseUp();
    expect(store.browse.cwd).toBe('/home/kai');
    expect(store.browse.dirs?.map((dir) => dir.name)).toEqual(['projects']);
    await store.browseUp();
    expect(store.browse.cwd).toBe('/home/kai');
    expect(browse.listDirs).toHaveBeenCalledTimes(3);
  });

  it('records a browse listing failure as browse.error, not a throw', async () => {
    const browse = {
      home: vi.fn(async () => '/home/kai'),
      listDirs: vi.fn(async (dir: string) => {
        if (dir === '/home/kai/projects') throw new Error('sftpList failed');
        return [];
      }),
    };
    const store = createProjectsStore(deps({ browse }) as never);
    await store.openBrowse();
    await store.browseEnter('/home/kai/projects');
    expect(store.browse.error).toContain('sftpList failed');
    expect(store.browse.open).toBe(true);
    expect(store.browse.busy).toBe(false);
    expect(store.browse.cwd).toBe('/home/kai');
  });

  it('adds the browsed directory and closes the browser', async () => {
    const browse = {
      home: vi.fn(async () => '/home/kai'),
      listDirs: vi.fn(async () => [{ name: 'projects', path: '/home/kai/projects' }]),
    };
    const store = createProjectsStore(deps({
      listProjects: vi.fn(async () => []),
      browse,
    }) as never);
    await store.discover();
    await store.openBrowse();
    store.addProject(store.browse.cwd ?? '');
    expect(store.projects.map((p) => p.name)).toEqual(['kai']);
    expect(store.browse.open).toBe(false);
  });
});
