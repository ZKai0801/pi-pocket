/**
 * The options popup's data: the app-shipped lists answer instantly, and the
 * model list is asked of the host once per project — the same shape as
 * `chatCommands.ts`, so the composer stays presentational and a probe failure
 * only degrades the picker instead of blocking the command.
 *
 * Keyed per project (not per command): `pi --list-models` runs in the chat's
 * project directory, so a project-level settings file can narrow it, and a
 * chat in another project must not paint this one's list. Keyed per host too
 * when a backup cache is wired (`modelListCache`): two hosts hold different
 * pi installs and credentials, so their lists never mix.
 *
 * The probe is slow — pi builds its whole session runtime before it prints —
 * so with the backup wired a confirmed list paints the moment the picker
 * opens and a background probe replaces it when it lands: the rows are
 * immediate, only their freshness is late. Without the cache wired (or on a
 * miss) the picker waits on the probe as before.
 */
import { reactive } from 'vue';
import {
  optionSourceFor,
  thinkingOptions,
  type PiCommandOption,
} from '../pi/piCommandOptions';

export type ChatOptionState = 'idle' | 'loading' | 'ready' | 'error';

/** The backup contract `ModelListsCache` satisfies; a test double fits too. */
export interface ModelListBackup {
  load(host: string | null, projectPath: string | null): Promise<PiCommandOption[] | null>;
  save(
    host: string | null,
    projectPath: string | null,
    models: readonly PiCommandOption[],
  ): Promise<void>;
}

export interface ChatCommandOptionsDeps {
  /** The open chat's project directory, read now; null means no chat. */
  projectPath: () => string | null;
  /**
   * The host the chat's models are read from, read now; null means unknown.
   * The backup is keyed by host, so with it wired a null answer keeps the
   * backup silent rather than sharing one bucket between hosts.
   */
  hostName?: () => string | null;
  /** Ask the host which models it can reach. Rejects only on a transport fault. */
  listModels: (projectPath: string) => Promise<PiCommandOption[]>;
  /** Durable backup of last confirmed model lists, keyed by host and project. */
  modelListCache?: ModelListBackup;
}

export interface ChatCommandOptions {
  /** The model list's state; the app-shipped lists are always `'ready'`. */
  readonly state: ChatOptionState;
  /**
   * Why the last host answer failed, in the host's own words. Shown under the
   * retry so "could not read the list" is not the end of the story — the
   * reason lives on stderr, which nothing else in the app surfaces. A failed
   * refresh behind painted backup rows is not surfaced: the rows stand.
   */
  readonly error: string | null;
  /** The rows for `command`; empty while a host list is still loading. */
  optionsFor(command: string): readonly PiCommandOption[];
  /**
   * Resolve `command`'s options. A static source answers without work; the
   * model list paints the backup if one exists (probing once in the
   * background), and otherwise probes now — `force` being the picker's retry,
   * which always probes and never paints the backup.
   */
  load(command: string, options?: { force?: boolean }): Promise<void>;
}

export function createChatCommandOptions(deps: ChatCommandOptionsDeps): ChatCommandOptions {
  const state = reactive<{ models: PiCommandOption[]; state: ChatOptionState; error: string | null }>({
    models: [],
    state: 'idle',
    error: null,
  });

  /** The host+project whose model probe already answered `'ready'`. */
  let loadedProject: string | null = null;
  let loadedHost: string | null = null;
  let inFlight: { project: string; promise: Promise<void> } | null = null;

  function optionsFor(command: string): readonly PiCommandOption[] {
    const source = optionSourceFor(command);
    if (source === 'thinking') return thinkingOptions();
    if (source === 'models') return state.models;
    return [];
  }

  /**
   * One host probe. Live owns the loading/error states the sheet shows; a
   * refresh behind painted backup rows stays silent on failure — the rows it
   * would replace are already on screen, and swapping them for an error would
   * be a regression disguised as honesty. Both confirm the backup on success.
   */
  async function probe(project: string, host: string | null, silent: boolean): Promise<void> {
    try {
      const models = await deps.listModels(project);
      // The chat may have moved while the probe ran; a late answer must not
      // paint this host+project's models under another.
      if (deps.projectPath() !== project || (deps.hostName?.() ?? null) !== host) return;
      state.models = models;
      loadedProject = project;
      loadedHost = host;
      state.state = 'ready';
      void deps.modelListCache?.save(host, project, models);
    } catch (error) {
      if (silent) return;
      if (deps.projectPath() !== project || (deps.hostName?.() ?? null) !== host) return;
      state.models = [];
      state.error = error instanceof Error ? error.message : String(error);
      loadedProject = null;
      loadedHost = null;
      state.state = 'error';
    } finally {
      if (inFlight !== null && inFlight.project === project) inFlight = null;
    }
  }

  async function loadModels(force: boolean): Promise<void> {
    const project = deps.projectPath();
    if (project === null) return;
    const host = deps.hostName?.() ?? null;
    if (!force && loadedProject === project && loadedHost === host && state.state !== 'error') return;
    if (inFlight !== null && inFlight.project === project) return inFlight.promise;

    const promise = (async (): Promise<void> => {
      const cache = deps.modelListCache;
      if (!force && cache !== undefined) {
        const cached = await cache.load(host, project);
        if (cached !== null) {
          // The chat may have moved while the store was read; a late paint
          // must not land under another host+project either.
          if (deps.projectPath() === project && (deps.hostName?.() ?? null) === host) {
            state.models = cached;
            loadedProject = project;
            loadedHost = host;
            state.error = null;
            state.state = 'ready';
          }
          await probe(project, host, true);
          return;
        }
      }
      state.state = 'loading';
      state.error = null;
      await probe(project, host, false);
    })();
    inFlight = { project, promise };
    return promise;
  }

  async function load(command: string, options: { force?: boolean } = {}): Promise<void> {
    const source = optionSourceFor(command);
    if (source === null || source === 'thinking') return;
    await loadModels(options.force === true);
  }

  return reactive({
    get state() { return state.state; },
    get error() { return state.error; },
    optionsFor,
    load,
  });
}
