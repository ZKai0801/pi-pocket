/**
 * The Projects tab's store (spec §8.5): the Pi projects discovered on the
 * live host, the local search query, the selection the 会话 tab lists
 * sessions for, and the manually added projects that must list even before
 * their first session.
 *
 * `createProjectsStore` takes its dependencies as arguments so it is
 * testable with neither Pinia nor a device; `useProjectsStore` is the thin
 * Pinia wrapper that binds the shell's installed `PiLive` seam and the
 * per-host added-projects record in localStorage.
 *
 * The wrapper resolves the live seam lazily at call time (R9): a discovery
 * before the shell owns a connection rejects through `resolveRoot` and
 * lands in `state: 'error'` — never a throw.
 *
 * `discover()` resolves with `true` when this call ran the discovery and
 * `false` when it was suppressed because a run was already in flight; the
 * suppressed promise resolves only after that in-flight run completes, so a
 * caller (e.g. the host-switch watch) can re-discover instead of being
 * dropped.
 */
import { computed, reactive, toRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { PiRepository, type PiProject } from '../pi/piRepository';
import { resolveSessionRoot } from '../pi/resolveSessionRoot';
import { piLive, type PiDirectoryEntry } from '../session/piLive';
import { useConnectionsStore } from './connections';

export type ProjectsState = 'idle' | 'loading' | 'ready' | 'no-root' | 'error';

/** Per-host persistence of the manually added projects (R9). */
export interface ProjectsAddedDep {
  load(): Promise<string[]>;
  save(paths: string[]): Promise<void>;
}

/** The server directory browser behind 新增项目 (R9). */
export interface ProjectsBrowseDep {
  home(): Promise<string>;
  listDirs(path: string): Promise<PiDirectoryEntry[]>;
}

export interface ProjectsBrowseState {
  open: boolean;
  cwd: string | null;
  /** The browser's root ($HOME); the up-arrow clamps here. */
  root: string | null;
  dirs: PiDirectoryEntry[] | null;
  error: string | null;
  busy: boolean;
}

export interface ProjectsStoreState {
  projects: PiProject[];
  state: ProjectsState;
  error: string | null;
  query: string;
  /** The project the 会话 tab will list sessions for (spec §8.5). */
  selected: string | null;
  browse: ProjectsBrowseState;
}

export interface ProjectsStore extends ProjectsStoreState {
  /** `projects` filtered by `query`, case-insensitively on path and name. */
  readonly filtered: PiProject[];
  /**
   * Runs the discovery. Resolves with `true` when this call ran it; with
   * `false` when a run was already in flight, in which case the promise
   * resolves only after that run completes so the caller can retry.
   */
  discover(): Promise<boolean>;
  setQuery(query: string): void;
  addProject(path: string): void;
  select(path: string): void;
  openBrowse(): Promise<void>;
  browseEnter(path: string): Promise<void>;
  browseUp(): Promise<void>;
  closeBrowse(): void;
}

export interface ProjectsStoreDeps {
  resolveRoot(): Promise<string | null>;
  /** Root-bound (R9): `PiRepository` is constructed against the resolved root. */
  listProjects(root: string): Promise<PiProject[]>;
  added?: ProjectsAddedDep;
  browse?: ProjectsBrowseDep;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'The projects could not be listed.';
}

function projectNameFromPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed.length <= 1) return '/';
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}

export function createProjectsStore(deps: ProjectsStoreDeps): ProjectsStore {
  const state = reactive<ProjectsStoreState>({
    projects: [],
    state: 'idle',
    error: null,
    query: '',
    selected: null,
    browse: { open: false, cwd: null, root: null, dirs: null, error: null, busy: false },
  });

  // The added paths as this store knows them. Only a RESOLVED `added.load()`
  // may arm the persistence below: after a rejected load, `addProject` must
  // not write a fresh in-memory list back and erase the stored one (R9).
  let addedPaths: string[] = [];
  let addedLoaded = false;

  let discovering = false;
  let browseOpening = false;

  function filteredProjects(): PiProject[] {
    const needle = state.query.toLowerCase();
    if (needle === '') return state.projects;
    return state.projects.filter(
      (project) =>
        project.name.toLowerCase().includes(needle) ||
        project.path.toLowerCase().includes(needle),
    );
  }

  async function loadAdded(): Promise<PiProject[]> {
    if (!deps.added) return [];
    try {
      addedPaths = await deps.added.load();
      addedLoaded = true;
      return addedPaths.map((path) => ({ path, name: projectNameFromPath(path) }));
    } catch {
      // Storage can be unavailable; the added list degrades to empty and the
      // discovered list still stands (R9).
      addedPaths = [];
      return [];
    }
  }

  // A second `discover()` while one is running must not re-list, and must
  // not drop its caller either (D8 interleaving, host-switch fix): it
  // resolves with `false` only after the in-flight run completes. Claimed
  // synchronously before the first `await`; released on every exit path.
  const suppressed: Array<() => void> = [];

  async function discover(): Promise<boolean> {
    if (discovering) {
      return new Promise<boolean>((resolve) => {
        suppressed.push(() => resolve(false));
      });
    }
    discovering = true;
    try {
      state.state = 'loading';
      state.error = null;

      const added = await loadAdded();
      const root = await deps.resolveRoot();
      if (root === null) {
        // No session root on this host (Review Focus 3): say so, and still
        // list what the user added by hand.
        state.projects = added;
        state.state = 'no-root';
        return true;
      }
      const discovered = await deps.listProjects(root);
      const seen = new Set(discovered.map((project) => project.path));
      // Discovered first, added behind, de-duped by path (R9).
      state.projects = [...discovered, ...added.filter((project) => !seen.has(project.path))];
      state.state = 'ready';
      return true;
    } catch (error) {
      // A failed discovery is an error, never an empty list masquerading as
      // "no projects" (Review Focus 4).
      state.projects = [];
      state.state = 'error';
      state.error = errorMessage(error);
      return true;
    } finally {
      discovering = false;
      for (const resolve of suppressed.splice(0)) resolve();
    }
  }

  function setQuery(query: string): void {
    state.query = query;
  }

  function select(path: string): void {
    state.selected = path;
  }

  function addProject(path: string): void {
    const target = path.replace(/\/+$/, '');
    if (target === '') return;
    if (!state.projects.some((project) => project.path === target)) {
      state.projects = [...state.projects, { path: target, name: projectNameFromPath(target) }];
    }
    if (!addedPaths.includes(target)) addedPaths = [...addedPaths, target];
    if (deps.added && addedLoaded) {
      void deps.added.save(addedPaths).catch(() => {
        // A write that fails still leaves the in-memory list standing.
      });
    }
    closeBrowse();
  }

  async function openBrowse(): Promise<void> {
    if (!deps.browse || state.browse.open || browseOpening) return;
    browseOpening = true;
    state.browse.open = true;
    state.browse.error = null;
    state.browse.busy = true;
    try {
      const home = await deps.browse.home();
      const dirs = await deps.browse.listDirs(home);
      state.browse.root = home;
      state.browse.cwd = home;
      state.browse.dirs = dirs;
    } catch (error) {
      state.browse.error = errorMessage(error);
    } finally {
      state.browse.busy = false;
      browseOpening = false;
    }
  }

  async function browseEnter(path: string): Promise<void> {
    if (!deps.browse || state.browse.busy) return;
    state.browse.busy = true;
    state.browse.error = null;
    try {
      // The cwd moves only after the listing succeeded, so a failed enter
      // leaves the browser where it was.
      const dirs = await deps.browse.listDirs(path);
      state.browse.cwd = path;
      state.browse.dirs = dirs;
    } catch (error) {
      state.browse.error = errorMessage(error);
    } finally {
      state.browse.busy = false;
    }
  }

  async function browseUp(): Promise<void> {
    const cwd = state.browse.cwd;
    const root = state.browse.root;
    if (cwd === null || root === null || state.browse.busy || cwd === root) return;
    await browseEnter(parentPath(cwd));
  }

  function closeBrowse(): void {
    state.browse.open = false;
    state.browse.cwd = null;
    state.browse.root = null;
    state.browse.dirs = null;
    state.browse.error = null;
    state.browse.busy = false;
  }

  return reactive({
    get projects() { return state.projects; },
    set projects(value: PiProject[]) { state.projects = value; },
    get state() { return state.state; },
    set state(value: ProjectsState) { state.state = value; },
    get error() { return state.error; },
    set error(value: string | null) { state.error = value; },
    get query() { return state.query; },
    set query(value: string) { state.query = value; },
    get selected() { return state.selected; },
    set selected(value: string | null) { state.selected = value; },
    get browse() { return state.browse; },
    set browse(value: ProjectsBrowseState) { state.browse = value; },
    get filtered() { return filteredProjects(); },
    discover,
    setQuery,
    addProject,
    select,
    openBrowse,
    browseEnter,
    browseUp,
    closeBrowse,
  });
}

/** The single key for the per-host added-projects record (R9). */
export const ADDED_PROJECTS_STORAGE_KEY = 'pocketshell.android.pi.addedProjects.v1';

interface AddedProjectsRecord {
  [hostName: string]: string[];
}

interface ProjectsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function projectsStorage(): ProjectsStorage | null {
  try {
    const storage = (globalThis as { localStorage?: ProjectsStorage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function readAddedRecord(): AddedProjectsRecord {
  let raw: string | null = null;
  try {
    raw = projectsStorage()?.getItem(ADDED_PROJECTS_STORAGE_KEY) ?? null;
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const record: AddedProjectsRecord = {};
  for (const [hostName, paths] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      hostName &&
      Array.isArray(paths) &&
      paths.every((path) => typeof path === 'string' && path.length > 0)
    ) {
      record[hostName] = paths as string[];
    }
  }
  return record;
}

function writeAddedRecord(record: AddedProjectsRecord): void {
  try {
    const storage = projectsStorage();
    if (!storage) return;
    if (Object.keys(record).length === 0) storage.removeItem(ADDED_PROJECTS_STORAGE_KEY);
    else storage.setItem(ADDED_PROJECTS_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage can be unavailable or full; the in-memory list still stands.
  }
}

export const useProjectsStore = defineStore('projects', () => {
  const store = createProjectsStore({
    // Bound lazily at call time through the shell's live seam (R9): the
    // remote $HOME and env only the live connection can answer, plus the
    // active host's per-host session-root override.
    resolveRoot: async () => {
      const live = piLive();
      const context = await live.remoteContext();
      const connections = useConnectionsStore();
      const active = connections.activeName !== null
        ? connections.hosts.find((host) => host.name === connections.activeName)
        : undefined;
      return resolveSessionRoot(live.transport(), context.home, context.env, active?.piSessionsDir);
    },
    listProjects: (root) => new PiRepository(piLive().transport(), root).listProjects(),
    added: {
      load: async () => {
        const connections = useConnectionsStore();
        if (connections.activeName === null) return [];
        return readAddedRecord()[connections.activeName] ?? [];
      },
      save: async (paths) => {
        const connections = useConnectionsStore();
        if (connections.activeName === null) return;
        const record = readAddedRecord();
        record[connections.activeName] = paths;
        writeAddedRecord(record);
      },
    },
    browse: {
      home: async () => (await piLive().remoteContext()).home,
      listDirs: (path) => piLive().listDirectories(path),
    },
  });

  // The added record and the discovery both key off the active host: the
  // moment the host changes, the previous host's list and selection are
  // stale, so re-discover. Switching to null leaves the connect-first hint
  // to speak (the shell releases the live seam on disconnect). A suppressed
  // re-discover (the previous host's run still settling) must not be
  // dropped: retry once, only while the host is still the one that
  // triggered the watch.
  const connections = useConnectionsStore();
  watch(
    () => connections.activeName,
    (name) => {
      store.selected = null;
      if (name === null) return;
      const triggeredFor = name;
      void store.discover().then((ran) => {
        if (!ran && connections.activeName === triggeredFor) void store.discover();
      });
    },
  );

  return {
    projects: toRef(store, 'projects'),
    state: toRef(store, 'state'),
    error: toRef(store, 'error'),
    query: toRef(store, 'query'),
    selected: toRef(store, 'selected'),
    browse: toRef(store, 'browse'),
    filtered: computed(() => store.filtered),
    discover: store.discover,
    setQuery: store.setQuery,
    addProject: store.addProject,
    select: store.select,
    openBrowse: store.openBrowse,
    browseEnter: store.browseEnter,
    browseUp: store.browseUp,
    closeBrowse: store.closeBrowse,
  };
});
