/**
 * The options popup's data: the app-shipped lists answer instantly, and the
 * model list is asked of the host once per project — the same shape as
 * `chatCommands.ts`, so the composer stays presentational and a probe failure
 * only degrades the picker instead of blocking the command.
 *
 * Keyed per project (not per command): `pi --list-models` runs in the chat's
 * project directory, so a project-level settings file can narrow it, and a
 * chat in another project must not paint this one's list.
 */
import { reactive } from 'vue';
import {
  optionSourceFor,
  thinkingOptions,
  type PiCommandOption,
} from '../pi/piCommandOptions';

export type ChatOptionState = 'idle' | 'loading' | 'ready' | 'error';

export interface ChatCommandOptionsDeps {
  /** The open chat's project directory, read now; null means no chat. */
  projectPath: () => string | null;
  /** Ask the host which models it can reach. Rejects only on a transport fault. */
  listModels: (projectPath: string) => Promise<PiCommandOption[]>;
}

export interface ChatCommandOptions {
  /** The model list's state; the app-shipped lists are always `'ready'`. */
  readonly state: ChatOptionState;
  /**
   * Why the last host answer failed, in the host's own words. Shown under the
   * retry so "could not read the list" is not the end of the story — the
   * reason lives on stderr, which nothing else in the app surfaces.
   */
  readonly error: string | null;
  /** The rows for `command`; empty while a host list is still loading. */
  optionsFor(command: string): readonly PiCommandOption[];
  /**
   * Resolve `command`'s options. A static source answers without work; the
   * model list is probed unless the same project already answered, `force`
   * being the picker's retry.
   */
  load(command: string, options?: { force?: boolean }): Promise<void>;
}

export function createChatCommandOptions(deps: ChatCommandOptionsDeps): ChatCommandOptions {
  const state = reactive<{ models: PiCommandOption[]; state: ChatOptionState; error: string | null }>({
    models: [],
    state: 'idle',
    error: null,
  });

  /** The project whose model probe already answered `'ready'`. */
  let loadedProject: string | null = null;
  let inFlight: { project: string; promise: Promise<void> } | null = null;

  function optionsFor(command: string): readonly PiCommandOption[] {
    const source = optionSourceFor(command);
    if (source === 'thinking') return thinkingOptions();
    if (source === 'models') return state.models;
    return [];
  }

  async function loadModels(force: boolean): Promise<void> {
    const project = deps.projectPath();
    if (project === null) return;
    if (!force && loadedProject === project && state.state !== 'error') return;
    if (inFlight !== null && inFlight.project === project) return inFlight.promise;

    state.state = 'loading';
    state.error = null;
    const promise = (async (): Promise<void> => {
      try {
        const models = await deps.listModels(project);
        // The chat may have moved to another project while the probe ran; a
        // late answer must not paint this project's models under that one.
        if (deps.projectPath() !== project) return;
        state.models = models;
        loadedProject = project;
        state.state = 'ready';
      } catch (error) {
        if (deps.projectPath() !== project) return;
        state.models = [];
        state.error = error instanceof Error ? error.message : String(error);
        loadedProject = null;
        state.state = 'error';
      } finally {
        if (inFlight !== null && inFlight.project === project) inFlight = null;
      }
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
