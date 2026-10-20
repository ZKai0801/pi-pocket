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
import type { SshCredential, SshHostTarget } from '@pocketshell/core';
import type { AndroidHostStore, HostAuth, SavedHost } from '../platform/android/hostStore';
import type { RememberedSecretKind, RememberedSecrets } from '../native/rememberedSecrets';
import { buildSshCredential } from '../credentials/buildSshCredential';
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
  /** The host a switch is waiting to confirm before closing the live one (spec §8.2). */
  pendingSwitch: string | null;
}

export interface ConnectionsStore extends ConnectionsStoreState {
  load(): void;
  /**
   * Save a host, sealing `secret` (a passphrase or password) first. The old
   * record keeps its rename semantics; a secret the new record no longer
   * references is forgotten after the write.
   */
  save(host: SavedHost, previousName?: string | null, secret?: string | null): Promise<void>;
  /** Seal a secret for the host and write the record; never renames. */
  saveSecret(host: SavedHost, secret: string): Promise<void>;
  /** The explicit "clear saved credentials" action: forget and rewrite the record. */
  forgetSecrets(name: string): Promise<void>;
  /** Removes the host and, if it is the live one, closes it first (D8). */
  remove(name: string): Promise<void>;
  connect(name: string): Promise<void>;
  /** Connect, or ask to switch when another host is already live (spec §8.2). */
  requestConnect(name: string): Promise<void>;
  /** Proceed with the switch the user agreed to. */
  confirmSwitch(): Promise<void>;
  /** Leave the live connection untouched and drop the pending switch. */
  cancelSwitch(): void;
  disconnect(): Promise<void>;
  /** `connected` only for the active host; every other host is `idle` (D8). */
  statusFor(name: string): 'connected' | 'idle';
  /** Reconcile the active host's status with a `ConnectionController` phase (spec §8.2). */
  applyConnectionSnapshot(phase: string): void;
  /** Set or clear the active host's per-host Pi sessions directory override (spec §9.1). */
  setPiSessionsDir(name: string, dir: string): void;
}

export interface ConnectionsStoreDeps {
  hosts: ConnectionsHosts;
  port: ConnectionPort;
  /** Optional so existing callers and tests keep their dependency shape. */
  secrets?: RememberedSecrets;
}

/**
 * The fail-closed default: nothing is remembered, forgetting is a no-op, and a
 * write is refused loudly rather than silently losing a secret.
 */
const NO_REMEMBERED_SECRETS: RememberedSecrets = {
  put: async () => { throw new Error('The remembered-secret store is not available.'); },
  resolve: async () => null,
  forget: async () => {},
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'The connection could not be opened.';
}

/** Which sealed secret a newly typed value becomes for this host. */
function secretKind(host: SavedHost): RememberedSecretKind {
  return host.auth?.kind === 'password' ? 'password' : 'key-passphrase';
}

/** Every id a record holds, whether or not it currently uses it. */
function heldSecretIds(host: SavedHost | undefined): Set<string> {
  const ids = new Set<string>();
  if (!host) return ids;
  if (host.auth?.kind === 'password') {
    if (host.auth.passwordCredentialId) ids.add(host.auth.passwordCredentialId);
  } else if (host.auth?.kind === 'key' && host.auth.secretId) {
    ids.add(host.auth.secretId);
  }
  return ids;
}

/** The ids a written record actually reads from the store at dial time. */
function referencedSecretIds(host: SavedHost): Set<string> {
  if (host.auth?.kind === 'password') {
    return host.auth.passwordCredentialId ? new Set([host.auth.passwordCredentialId]) : new Set();
  }
  if (host.auth?.kind === 'key' && host.auth.rememberPassphrase === true && host.auth.secretId) {
    return new Set([host.auth.secretId]);
  }
  return new Set();
}

/** Drop a secret id the record would not use, so it can be forgotten. */
function withoutUnusedSecretId(host: SavedHost): SavedHost {
  if (host.auth?.kind !== 'key' || host.auth.secretId === undefined) return host;
  if (host.auth.rememberPassphrase === true) return host;
  const { secretId: _unused, ...auth } = host.auth;
  return { ...host, auth };
}

/** Write a newly sealed id into the field the record's auth kind reads. */
function withSealedSecret(host: SavedHost, secretId: string): SavedHost {
  if (host.auth?.kind === 'password') {
    return { ...host, auth: { kind: 'password', passwordCredentialId: secretId } };
  }
  const auth = host.auth ?? { kind: 'key' as const, keyHandleId: host.keyHandleId };
  return { ...host, auth: { ...auth, rememberPassphrase: true, secretId } };
}

/** Rewrite the record without any id it used to point at. */
function withoutSecretIds(host: SavedHost): SavedHost {
  if (host.auth?.kind === 'password') {
    return { ...host, auth: { kind: 'password', passwordCredentialId: '' } };
  }
  if (host.auth?.kind !== 'key') return host;
  const auth: HostAuth = { kind: 'key', keyHandleId: host.auth.keyHandleId };
  return { ...host, auth };
}

export function createConnectionsStore(deps: ConnectionsStoreDeps): ConnectionsStore {
  const state = reactive<ConnectionsStoreState>({
    hosts: [],
    activeName: null,
    status: 'idle',
    lastError: null,
    pendingSwitch: null,
  });

  const secrets = deps.secrets ?? NO_REMEMBERED_SECRETS;

  function load(): void {
    state.hosts = deps.hosts.savedHosts();
  }

  function findRecord(name: string): SavedHost | undefined {
    return deps.hosts.savedHosts().find((candidate) => candidate.name === name)
      ?? state.hosts.find((candidate) => candidate.name === name);
  }

  /** The records a save replaces: the renamed one and any same-name one. */
  function previousRecords(previousName: string | null | undefined, name: string): SavedHost[] {
    const records = new Map<string, SavedHost>();
    for (const candidate of [previousName ?? name, name]) {
      const record = findRecord(candidate);
      if (record) records.set(record.name, record);
    }
    return [...records.values()];
  }

  /** Forgetting is cleanup: it never fails the write or delete that caused it. */
  async function forgetSwallowed(ids: Iterable<string>): Promise<void> {
    for (const id of new Set(ids)) {
      try {
        await secrets.forget(id);
      } catch {
        // An orphaned secret is recoverable; a failed save or delete is not.
      }
    }
  }

  async function save(host: SavedHost, previousName?: string | null, secret?: string | null): Promise<void> {
    const previous = previousRecords(previousName, host.name);
    const typed = typeof secret === 'string' && secret.length > 0 ? secret : null;
    const record = typed === null
      ? withoutUnusedSecretId(host)
      : withSealedSecret(host, await secrets.put(typed, secretKind(host)));

    // A rename replaces the old record rather than sitting beside it, and the
    // active row follows the new name so it keeps its connected state.
    const renamed = Boolean(previousName) && previousName !== record.name;
    if (renamed) {
      deps.hosts.remove(previousName as string);
      if (state.activeName === previousName) state.activeName = record.name;
      if (state.pendingSwitch === previousName) state.pendingSwitch = record.name;
    }
    deps.hosts.save(record);
    load();

    const stillReferenced = referencedSecretIds(record);
    const stale = previous.flatMap((old) => [...heldSecretIds(old)]).filter((id) => !stillReferenced.has(id));
    await forgetSwallowed(stale);
  }

  async function saveSecret(host: SavedHost, secret: string): Promise<void> {
    await save(host, null, secret);
  }

  async function forgetSecrets(name: string): Promise<void> {
    const host = findRecord(name);
    if (!host) return;
    for (const id of heldSecretIds(host)) await secrets.forget(id);
    deps.hosts.save(withoutSecretIds(host));
    load();
  }

  function setPiSessionsDir(name: string, dir: string): void {
    const host = state.hosts.find((candidate) => candidate.name === name)
      ?? deps.hosts.savedHosts().find((candidate) => candidate.name === name);
    if (!host) return;
    const next: SavedHost = { ...host };
    const trimmed = dir.trim();
    if (trimmed.length > 0) next.piSessionsDir = trimmed;
    else delete next.piSessionsDir;
    deps.hosts.save(next);
    load();
  }

  async function remove(name: string): Promise<void> {
    const removed = findRecord(name);
    // D8: never drop the tracking of a live connection without closing it.
    if (state.activeName === name) await disconnect();
    deps.hosts.remove(name);
    load();
    // The record is gone, so its sealed secrets must not survive it.
    await forgetSwallowed(heldSecretIds(removed));
  }

  const CONNECTED_PHASES = new Set(['connected', 'listing', 'attaching', 'live']);

  function statusFor(name: string): 'connected' | 'idle' {
    return state.activeName === name && state.status === 'connected' ? 'connected' : 'idle';
  }

  function applyConnectionSnapshot(phase: string): void {
    // No live host means no per-host status to speak for; leave the dial's own
    // error/connecting state alone.
    if (state.activeName === null) return;
    if (CONNECTED_PHASES.has(phase)) {
      state.status = 'connected';
      return;
    }
    if (phase === 'idle' || phase === 'error' || phase === 'lost') {
      // The controller has no connection any more: stop tracking the host so
      // the switch gate and the row's tap say what is actually true.
      state.status = phase === 'idle' ? 'idle' : 'error';
      state.activeName = null;
      state.pendingSwitch = null;
      return;
    }
    state.status = 'connecting';
  }

  /** A tracked host that is connected or still reconnecting. */
  function hasLiveConnection(): boolean {
    return state.activeName !== null
      && (state.status === 'connected' || state.status === 'connecting');
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
    state.pendingSwitch = null;
  }

  async function requestConnect(name: string): Promise<void> {
    // D8: only one live connection, so switching hosts must close the current
    // one — but never before the user agrees (spec §8.2). Re-requesting the
    // already-live host changes nothing.
    if (hasLiveConnection()) {
      if (state.activeName !== name) state.pendingSwitch = name;
      return;
    }
    await connect(name);
  }

  async function confirmSwitch(): Promise<void> {
    const name = state.pendingSwitch;
    state.pendingSwitch = null;
    if (name !== null) await connect(name);
  }

  function cancelSwitch(): void {
    state.pendingSwitch = null;
  }

  // D8 under interleaving: a second `connect()` while one is dialling must not
  // skip the close-and-redial bookkeeping and dial a second connection. Claimed
  // synchronously before the first `await`; released on every exit path.
  let inFlight = false;

  async function connect(name: string): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const host = state.hosts.find((candidate) => candidate.name === name)
        ?? deps.hosts.savedHosts().find((candidate) => candidate.name === name);
      if (!host) {
        // A validation failure, not a dial: it must not disturb a live
        // connection. Record the error and leave `activeName`/`status` saying
        // what is actually connected (D8).
        state.lastError = `No saved host named “${name}”.`;
        return;
      }
      // D8: one live connection — close the current host before opening another.
      if (state.activeName !== null) await disconnect();
      state.status = 'connecting';
      state.activeName = null;
      state.lastError = null;
      state.pendingSwitch = null;

      // Every saved host dials with a credential built here, from opaque ids
      // only: a v1 key host falls back to its key handle (Plan 4, R29).
      let credential: SshCredential;
      try {
        credential = await buildSshCredential(
          host.auth ?? { kind: 'key', keyHandleId: host.keyHandleId },
          (secretId) => secrets.resolve(secretId),
        );
      } catch (error) {
        // A missing password is an actionable failure, not a dial.
        state.status = 'error';
        state.lastError = errorMessage(error);
        return;
      }

      let target: SshHostTarget;
      try {
        target = await deps.hosts.resolve({
          host: host.hostname,
          port: host.port,
          user: host.user,
          hostAlias: host.name,
        }, credential);
      } catch (error) {
        state.status = 'error';
        state.lastError = errorMessage(error);
        return;
      }

      let result: { ok: boolean };
      try {
        result = await deps.port.connect(target);
      } catch (error) {
        state.status = 'error';
        state.lastError = errorMessage(error);
        return;
      }
      // A resolved `{ ok: false }` is a failed dial, handled exactly like a
      // thrown one — never a false "connected" (D8).
      if (!result.ok) {
        state.status = 'error';
        state.lastError = `The connection to “${host.name}” did not open.`;
        return;
      }

      state.activeName = host.name;
      state.status = 'connected';
    } finally {
      inFlight = false;
    }
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
    get pendingSwitch() { return state.pendingSwitch; },
    set pendingSwitch(value: string | null) { state.pendingSwitch = value; },
    load,
    save,
    saveSecret,
    forgetSecrets,
    remove,
    connect,
    requestConnect,
    confirmSwitch,
    cancelSwitch,
    disconnect,
    statusFor,
    applyConnectionSnapshot,
    setPiSessionsDir,
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

let rememberedSecretsPromise: Promise<RememberedSecrets | null> | null = null;

/** The real Keystore-sealed store, imported lazily like the saved hosts. */
function loadRememberedSecrets(): Promise<RememberedSecrets | null> {
  rememberedSecretsPromise ??= import('../native/rememberedSecrets')
    .then((module) => module.rememberedSecrets)
    .catch(() => null);
  return rememberedSecretsPromise;
}

const lazySecrets: RememberedSecrets = {
  async put(secret, kind, secretId) {
    const real = await loadRememberedSecrets();
    if (!real) throw new Error('The Android remembered-secret store is not available.');
    return real.put(secret, kind, secretId);
  },
  async resolve(secretId) {
    const real = await loadRememberedSecrets();
    return real ? real.resolve(secretId) : null;
  },
  async forget(secretId) {
    const real = await loadRememberedSecrets();
    if (real) await real.forget(secretId);
  },
};

export const useConnectionsStore = defineStore('connections', () => {
  let realHosts: ConnectionsHosts | null = null;
  // Bound before the dynamic import resolves; the app calls `load()` again once
  // the real singleton is here. A dial before then fails closed (resolve
  // rejects), never throws.
  const lazyHosts: ConnectionsHosts = {
    savedHosts: () => realHosts?.savedHosts() ?? [],
    save: (host) => { realHosts?.save(host); },
    remove: (name) => { realHosts?.remove(name); },
    resolve: (request, credential) => realHosts
      ? realHosts.resolve(request, credential)
      : Promise.reject(new Error('The saved hosts are still loading.')),
  };

  const store = createConnectionsStore({ hosts: lazyHosts, port: shellPort, secrets: lazySecrets });
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
    pendingSwitch: toRef(store, 'pendingSwitch'),
    load: store.load,
    save: store.save,
    saveSecret: store.saveSecret,
    forgetSecrets: store.forgetSecrets,
    remove: store.remove,
    connect: store.connect,
    requestConnect: store.requestConnect,
    confirmSwitch: store.confirmSwitch,
    cancelSwitch: store.cancelSwitch,
    disconnect: store.disconnect,
    statusFor: store.statusFor,
    applyConnectionSnapshot: store.applyConnectionSnapshot,
    setPiSessionsDir: store.setPiSessionsDir,
  };
});
