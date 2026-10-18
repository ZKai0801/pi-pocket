/**
 * The Connections tab's store: the phone's saved hosts, which one is live, and
 * the dial/close actions that move between them.
 *
 * `createConnectionsStore` takes its dependencies as arguments so it is
 * testable with neither Pinia nor a device; `useConnectionsStore` is the thin
 * Pinia wrapper that binds the real `androidHosts` singleton and the shell's
 * installed `ConnectionPort`.
 *
 * The wrapper resolves `androidHosts` with a dynamic import, the same way
 * `SettingsScreen.vue` and `platform/android/sync.ts` do: `hosts.ts` touches
 * `window.localStorage` at module scope, and unit tests run in a Node
 * environment with no `window`. Binding lazily keeps this module loadable
 * everywhere while still handing the real shared singleton to the app.
 */
import { reactive, toRef } from 'vue';
import { defineStore } from 'pinia';
import type { SshHostTarget } from '@pocketshell/core';
import type { AndroidHostStore, SavedHost } from '../platform/android/hostStore';
import { connectionPort, type ConnectionPort } from '../session/connectionPort';

/** The exact method surface the store needs from the Android host source. */
export type ConnectionsHosts = Pick<AndroidHostStore, 'savedHosts' | 'save' | 'remove' | 'resolve'>;

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface ConnectionsStoreState {
  hosts: SavedHost[];
  /** The one host the shell has dialled and not yet closed (D8). */
  activeName: string | null;
  status: ConnectionStatus;
  lastError: string | null;
}

export interface ConnectionsStore extends ConnectionsStoreState {
  load(): void;
  save(host: SavedHost): void;
  remove(name: string): void;
  connect(name: string): Promise<void>;
  disconnect(): Promise<void>;
  /** `connected` only for the active host; every other host is `idle` (D8). */
  statusFor(name: string): 'connected' | 'idle';
}

export interface ConnectionsStoreDeps {
  hosts: ConnectionsHosts;
  port: ConnectionPort;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'The connection could not be opened.';
}

export function createConnectionsStore(deps: ConnectionsStoreDeps): ConnectionsStore {
  const state = reactive<ConnectionsStoreState>({
    hosts: [],
    activeName: null,
    status: 'idle',
    lastError: null,
  });

  function load(): void {
    state.hosts = deps.hosts.savedHosts();
  }

  function save(host: SavedHost): void {
    deps.hosts.save(host);
    load();
  }

  function remove(name: string): void {
    deps.hosts.remove(name);
    if (state.activeName === name) {
      state.activeName = null;
      state.status = 'idle';
      state.lastError = null;
    }
    load();
  }

  function statusFor(name: string): 'connected' | 'idle' {
    return state.activeName === name && state.status === 'connected' ? 'connected' : 'idle';
  }

  async function disconnect(): Promise<void> {
    try {
      await deps.port.disconnect();
    } catch {
      // A close that fails natively still leaves the shell with no live host.
    }
    state.activeName = null;
    state.status = 'idle';
    state.lastError = null;
  }

  async function connect(name: string): Promise<void> {
    const host = state.hosts.find((candidate) => candidate.name === name)
      ?? deps.hosts.savedHosts().find((candidate) => candidate.name === name);
    if (!host) {
      state.status = 'error';
      state.activeName = null;
      state.lastError = `No saved host named “${name}”.`;
      return;
    }
    // D8: one live connection — close the current host before opening another.
    if (state.activeName !== null) await disconnect();
    state.status = 'connecting';
    state.activeName = null;
    state.lastError = null;

    let target: SshHostTarget;
    try {
      target = await deps.hosts.resolve({
        host: host.hostname,
        port: host.port,
        user: host.user,
        hostAlias: host.name,
      });
    } catch (error) {
      state.status = 'error';
      state.lastError = errorMessage(error);
      return;
    }

    try {
      await deps.port.connect(target);
    } catch (error) {
      state.status = 'error';
      state.lastError = errorMessage(error);
      return;
    }

    state.activeName = host.name;
    state.status = 'connected';
  }

  return reactive({
    get hosts() { return state.hosts; },
    set hosts(value: SavedHost[]) { state.hosts = value; },
    get activeName() { return state.activeName; },
    set activeName(value: string | null) { state.activeName = value; },
    get status() { return state.status; },
    set status(value: ConnectionStatus) { state.status = value; },
    get lastError() { return state.lastError; },
    set lastError(value: string | null) { state.lastError = value; },
    load,
    save,
    remove,
    connect,
    disconnect,
    statusFor,
  });
}

/** Resolve the shell's installed port lazily, at dial time. */
const shellPort: ConnectionPort = {
  connect: (target) => connectionPort().connect(target),
  disconnect: () => connectionPort().disconnect(),
};

let androidHostsPromise: Promise<ConnectionsHosts> | null = null;

function loadAndroidHosts(): Promise<ConnectionsHosts> {
  androidHostsPromise ??= import('../platform/android/hosts').then((module) => module.androidHosts);
  return androidHostsPromise;
}

export const useConnectionsStore = defineStore('connections', () => {
  let realHosts: ConnectionsHosts | null = null;
  // Bound before the dynamic import resolves; the app calls `load()` again once
  // the real singleton is here. A dial before then fails closed (resolve
  // rejects), never throws.
  const lazyHosts: ConnectionsHosts = {
    savedHosts: () => realHosts?.savedHosts() ?? [],
    save: (host) => { realHosts?.save(host); },
    remove: (name) => { realHosts?.remove(name); },
    resolve: (request) => realHosts
      ? realHosts.resolve(request)
      : Promise.reject(new Error('The saved hosts are still loading.')),
  };

  const store = createConnectionsStore({ hosts: lazyHosts, port: shellPort });
  void loadAndroidHosts().then(
    (hosts) => {
      realHosts = hosts;
      store.load();
    },
    () => {
      // The saved hosts never loaded; the list simply stays empty.
    },
  );

  return {
    hosts: toRef(store, 'hosts'),
    activeName: toRef(store, 'activeName'),
    status: toRef(store, 'status'),
    lastError: toRef(store, 'lastError'),
    load: store.load,
    save: store.save,
    remove: store.remove,
    connect: store.connect,
    disconnect: store.disconnect,
    statusFor: store.statusFor,
  };
});
