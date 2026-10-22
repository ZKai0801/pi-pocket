/**
 * The chat composer's command list: the app-shipped pi catalog plus whatever
 * the host has installed, loaded once per project.
 *
 * Shaped like the other `createXxx(deps)` seams in `src/session/`: no Pinia, no
 * transport of its own, and the deps are read at call time so the store can be
 * built before a connection exists. A probe failure is NOT an error state for
 * the composer — the built-ins are always usable, and `state: 'error'` only
 * asks the sheet to say that the host's own commands are missing.
 */
import { reactive } from 'vue';
import {
  mergePiCommands,
  type PiCommandDiscovery,
  type PiSlashCommand,
} from '../pi/piSlashCommands';

export type ChatCommandState = 'idle' | 'loading' | 'ready' | 'error';

export interface ChatCommandCatalogDeps {
  /** The open chat's project directory, read now; null means no chat. */
  projectPath: () => string | null;
  /** Ask the host for its extension commands. Rejects only on a transport fault. */
  discover: (projectPath: string) => Promise<PiCommandDiscovery>;
}

export interface ChatCommandCatalog {
  /** Built-ins first, then the host's own commands. Never empty. */
  readonly commands: PiSlashCommand[];
  readonly state: ChatCommandState;
  /**
   * Load the host's commands for the open chat. A no-op once the same project
   * has answered, unless `force` is set (the sheet's 重试).
   */
  load(options?: { force?: boolean }): Promise<void>;
}

export function createChatCommandCatalog(deps: ChatCommandCatalogDeps): ChatCommandCatalog {
  const state = reactive<{
    commands: PiSlashCommand[];
    state: ChatCommandState;
  }>({
    commands: mergePiCommands([]),
    state: 'idle',
  });

  /** The project whose probe already answered `'ready'`. */
  let loadedProject: string | null = null;
  let inFlight: { project: string; promise: Promise<void> } | null = null;

  async function load(options: { force?: boolean } = {}): Promise<void> {
    const project = deps.projectPath();
    if (project === null) return;
    if (!options.force && loadedProject === project && state.state !== 'error') return;
    if (inFlight !== null && inFlight.project === project) return inFlight.promise;

    state.state = 'loading';
    const promise = (async (): Promise<void> => {
      try {
        const found = await deps.discover(project);
        // The chat may have moved to another project while the probe ran; a
        // late answer must not paint this project's commands under that one.
        if (deps.projectPath() !== project) return;
        state.commands = mergePiCommands(found.commands);
        if (found.error === null) {
          loadedProject = project;
          state.state = 'ready';
        } else {
          loadedProject = null;
          state.state = 'error';
        }
      } catch {
        if (deps.projectPath() !== project) return;
        state.commands = mergePiCommands([]);
        loadedProject = null;
        state.state = 'error';
      } finally {
        if (inFlight !== null && inFlight.project === project) inFlight = null;
      }
    })();
    inFlight = { project, promise };
    return promise;
  }

  return reactive({
    get commands() { return state.commands; },
    get state() { return state.state; },
    load,
  });
}
