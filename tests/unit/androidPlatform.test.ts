import { afterEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { provideApi } from '@ui/app/ipc';
import { useConnectionStore } from '@ui/app/stores/connection';
import { ConnectionController, type HostKeyTrustPin, type HostKeyTrustRequest } from '@pocketshell/core';
import {
  AndroidConnectionHub,
  connectionStateFor,
} from '@/platform/android/connectionHub';
import { createAndroidPlatform, RemovedCapability, UnsupportedCapability } from '@/platform/android/androidApi';
import { AndroidHostStore, ANDROID_HOSTS_STORAGE_KEY } from '@/platform/android/hostStore';
import { createLocalTrustStore, pinStorageKey } from '@/platform/android/trustStore';
import { recordShellBoot, selectShell, SHELL_BOOT_LOG_KEY } from '@/shellSelection';
import { FakeNative, HOST_KEY, MemoryStorage, settle, target } from './support/androidFakeNative';

/** The fixture key already pinned — for tests whose subject is not first contact. */
const PIN: HostKeyTrustPin = { kind: 'wire-key', ...HOST_KEY };

function harness(pin: HostKeyTrustPin | null = PIN) {
  const native = new FakeNative();
  const storage = new MemoryStorage();
  const trust = createLocalTrustStore(storage);
  if (pin) void trust.record(target.hostId, pin);
  let ids = 0;
  const controllers: ConnectionController[] = [];
  const hub = new AndroidConnectionHub({
    createController: () => {
      const controller = new ConnectionController({
        capability: native.capability(),
        trustStore: trust,
        createId: () => `r-${++ids}`,
        retryDelaysMs: [0, 0],
      });
      controllers.push(controller);
      return controller;
    },
  });
  return { native, storage, hub, controllers };
}

const open: Array<{ hub: AndroidConnectionHub; id: string }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map(({ hub, id }) => hub.close(id)));
});

describe('Android PocketShellApi platform', () => {
  it('never pins a first-contact key without a decision: no decider means refused', async () => {
    const first = harness(null);
    const refused = await first.hub.connect(target);
    expect(refused).toEqual({ ok: false, error: expect.stringContaining('was not trusted') });
    expect(first.storage.getItem(pinStorageKey(target.hostId))).toBeNull();
    expect(first.native.opened).toHaveLength(0);
  });

  it('asks the registered decider with host, key type and fingerprint, and honours each answer', async () => {
    const asked: HostKeyTrustRequest[] = [];
    const answering = (choice: 'accept-once' | 'accept-always' | 'reject') => {
      const h = harness(null);
      h.hub.setTrustDecider(async (request) => {
        asked.push(request);
        // Nothing may be pinned while the user is still looking at the key.
        expect(h.storage.getItem(pinStorageKey(target.hostId))).toBeNull();
        return choice;
      });
      return h;
    };

    const rejected = answering('reject');
    const refused = await rejected.hub.connect(target, undefined, 'fixture box');
    expect(refused).toEqual({ ok: false, error: 'Host key for fixture box was not trusted. No connection was opened.' });
    expect(asked[0]).toEqual({
      hostLabel: 'fixture box', hostname: 'fixture', port: 2222, user: 'u',
      keyType: 'ssh-ed25519', fingerprintSha256: 'SHA256:abc123',
    });
    expect(rejected.storage.getItem(pinStorageKey(target.hostId))).toBeNull();
    expect((await rejected.native.capability().resourceSnapshot('x')).connections).toBe(0);

    const once = answering('accept-once');
    const onceResult = await once.hub.connect(target);
    expect(onceResult).toEqual({ ok: true, connectionId: 'android-1' });
    open.push({ hub: once.hub, id: 'android-1' });
    expect(once.storage.getItem(pinStorageKey(target.hostId))).toBeNull();
    // The next connection is a new first contact: asked again.
    const askedBefore = asked.length;
    const again = await once.hub.connect(target);
    open.push({ hub: once.hub, id: again.connectionId! });
    expect(asked.length).toBe(askedBefore + 1);

    const always = answering('accept-always');
    const alwaysResult = await always.hub.connect(target);
    expect(alwaysResult.ok).toBe(true);
    open.push({ hub: always.hub, id: alwaysResult.connectionId! });
    expect(JSON.parse(always.storage.getItem(pinStorageKey(target.hostId))!)).toMatchObject({ fingerprintSha256: 'SHA256:abc123' });
    const pinnedAsks = asked.length;
    const pinned = await always.hub.connect(target);
    open.push({ hub: always.hub, id: pinned.connectionId! });
    expect(pinned.ok).toBe(true);
    expect(asked.length).toBe(pinnedAsks);
  });

  it('refuses a changed host key with a visible message and never asks about it', async () => {
    const changed = harness({ kind: 'sha256-fingerprint', fingerprintSha256: 'SHA256:other' });
    let asked = 0;
    changed.hub.setTrustDecider(async () => { asked += 1; return 'accept-always'; });
    const refused = await changed.hub.connect(target, undefined, 'fixture');
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/^Host key for fixture has changed — connection refused\. It now presents SHA256:abc123 instead of the trusted SHA256:other\./);
    expect(asked).toBe(0);
    expect(changed.native.opened).toHaveLength(0);
    expect(JSON.parse(changed.storage.getItem(pinStorageKey(target.hostId))!)).toMatchObject({ fingerprintSha256: 'SHA256:other' });
    // Not even an explicit standing decision overrides a changed key.
    expect((await changed.hub.connect(target, 'accept-always')).ok).toBe(false);
  });

  it('the shared connection store prompts through ssh.onTrustDecision instead of dialling accept-always', async () => {
    const { storage, hosts, created } = platform(null);
    hosts.save({ name: 'dev box', hostname: 'fixture', port: 2222, user: 'u', keyHandleId: 'handle-1' });
    expect(typeof created.api.ssh.onTrustDecision).toBe('function');
    provideApi(created.api);
    setActivePinia(createPinia());
    const connection = useConnectionStore();
    const host = (await created.api.ssh.listConfigHosts())[0]!;

    const dial = connection.connect(host);
    await settle(() => connection.pendingTrust !== null);
    expect(connection.pendingTrust).toMatchObject({ hostLabel: 'dev box', hostname: 'fixture', port: 2222, keyType: 'ssh-ed25519', fingerprintSha256: 'SHA256:abc123' });
    expect(connection.state).toBe('connecting');
    expect(storage.getItem(pinStorageKey(target.hostId))).toBeNull();
    connection.answerTrust('reject');
    expect(await dial).toBe(false);
    expect(connection.pendingTrust).toBeNull();
    expect(connection.error).toMatch(/was not trusted/);
    expect(storage.getItem(pinStorageKey(target.hostId))).toBeNull();

    const second = connection.connect(host);
    await settle(() => connection.pendingTrust !== null);
    connection.answerTrust('accept-always');
    expect(await second).toBe(true);
    open.push({ hub: created.hub, id: connection.connectionId! });
    expect(connection.state).toBe('connected');
    expect(JSON.parse(storage.getItem(pinStorageKey(target.hostId))!)).toMatchObject({ fingerprintSha256: 'SHA256:abc123' });
  });

  it('abandons a waiting host-key question when the user disconnects', async () => {
    const { hosts, created } = platform(null);
    hosts.save({ name: 'fixture', hostname: 'fixture', port: 2222, user: 'u', keyHandleId: 'handle-1' });
    provideApi(created.api);
    setActivePinia(createPinia());
    const connection = useConnectionStore();
    const dial = connection.connect((await created.api.ssh.listConfigHosts())[0]!);
    await settle(() => connection.pendingTrust !== null);
    await connection.disconnect();
    expect(await dial).toBe(false);
    expect(connection.pendingTrust).toBeNull();
  });

  it('ignores a caller-supplied standing accept: only the user\'s answer on the prompt trusts a key', async () => {
    const { storage, hosts, created, native } = platform(null);
    hosts.save({ name: 'fixture', hostname: 'fixture', port: 2222, user: 'u', keyHandleId: 'handle-1' });
    for (const tofuDecision of ['accept-always', 'accept-once'] as const) {
      const result = await created.api.ssh.connect({ host: 'fixture', port: 2222, user: 'u', tofuDecision });
      // No decider is registered, so the unknown key is refused, not pinned.
      expect(result).toEqual({ ok: false, error: expect.stringContaining('was not trusted') });
    }
    expect(storage.getItem(pinStorageKey(target.hostId))).toBeNull();
    expect(native.opened).toHaveLength(0);
  });

  // The chat-only cut (D45) removed the hub's attach machinery: the cases
  // that drove attach/sessions/PTY bookkeeping through it are deleted with
  // it. What survives here is the connect/trust/recovery contract.

  it('keeps one logical connection id and reports reconnecting, not lost, while the controller re-dials', async () => {
    const { native, hub, controllers } = harness();
    const { connectionId } = await hub.connect(target);
    expect(connectionId).toBe('android-1');
    open.push({ hub, id: connectionId! });
    const states: string[] = [];
    hub.onState(({ connectionId: id, state }) => {
      if (id === connectionId) states.push(state);
    });

    const dialsBefore = native.connects.length;
    native.dropTransport();
    await settle(() => native.connects.length === dialsBefore + 1
      && controllers.at(-1)!.getSnapshot().phase === 'connected');
    // The controller's re-dial reads as one recovery, never as a drop the
    // shared store would answer with its own reconnect loop.
    // (`reconnecting` repeats once per dial of the ladder, with its attempt.)
    expect(states.filter((state, index) => state !== states[index - 1])).toEqual(['reconnecting', 'connected']);
    // The recovered link carries traffic over the surviving exec channel.
    expect(await hub.exec(connectionId!, 'printf %s "$HOME"')).toEqual({ exitCode: 0, stdout: '/home/u', stderr: '' });
  });

  it('maps controller phases onto the shared connection states', () => {
    const base = { revision: 1, hostId: null, hostLabel: null, generationId: null, sessions: [], sessionListErrors: [], selectedSession: null, terminals: [], retryAttempt: 0, error: null, trustDecision: null, uncertainMutation: null };
    expect(connectionStateFor({ ...base, phase: 'live', connectionId: 'c' })).toBe('connected');
    expect(connectionStateFor({ ...base, phase: 'background', connectionId: null })).toBe('connected');
    expect(connectionStateFor({ ...base, phase: 'awaiting-trust', connectionId: null })).toBe('connecting');
    expect(connectionStateFor({ ...base, phase: 'reconnecting', connectionId: null })).toBe('reconnecting');
    expect(connectionStateFor({ ...base, phase: 'connecting', connectionId: null, retryAttempt: 2 })).toBe('reconnecting');
    expect(connectionStateFor({ ...base, phase: 'listing', connectionId: 'c' })).toBe('connected');
    expect(connectionStateFor({ ...base, phase: 'error', connectionId: 'c' })).toBe('connected');
    expect(connectionStateFor({ ...base, phase: 'error', connectionId: null })).toBe('lost');
    // A refused dial inside the retry ladder is not the give-up (#2954).
    expect(connectionStateFor({ ...base, phase: 'error', connectionId: null, retryAttempt: 1 })).toBe('reconnecting');
    expect(connectionStateFor({ ...base, phase: 'lost', connectionId: null })).toBe('lost');
  });

  function platform(pin: HostKeyTrustPin | null = PIN) {
    const { native, storage, controllers } = harness(pin);
    const hosts = new AndroidHostStore({ storage, readLegacyHosts: async () => [] });
    let lifecycle: ((active: boolean) => void) | null = null;
    let ids = 0;
    const created = createAndroidPlatform({
      createController: () => {
        const controller = new ConnectionController({
          capability: native.capability(),
          trustStore: createLocalTrustStore(storage),
          createId: () => `p-${++ids}`,
          retryDelaysMs: [0],
        });
        controllers.push(controller);
        return controller;
      },
      hosts,
      lifecycle: { onActiveChange: (handler) => { lifecycle = handler; return () => { lifecycle = null; }; } },
      backgroundGraceMs: () => 60_000,
      addHostRoute: '/android/hosts',
    });
    return { native, storage, hosts, created, controllers, emitActive: (active: boolean) => lifecycle?.(active) };
  }

  it('connects a saved host with its session key and serves bootstrap and home over the controller', async () => {
    const { native, hosts, created } = platform();
    expect(await created.api.ssh.listConfigHosts()).toEqual([]);
    expect(created.api.hosts?.emptyAction).toEqual({ label: 'Add a host', route: '/android/hosts' });

    hosts.save({ name: 'fixture', hostname: 'fixture', port: 2222, user: 'u', keyHandleId: 'handle-1' });
    expect((await created.api.ssh.listConfigHosts()).map((host) => host.name)).toEqual(['fixture']);
    const result = await created.api.ssh.connect({ host: 'fixture', port: 2222, user: 'u', tofuDecision: 'accept-always' });
    expect(result.ok).toBe(true);
    open.push({ hub: created.hub, id: result.connectionId! });
    expect(native.connects[0]).toMatchObject({ hostname: 'fixture', port: 2222, username: 'u', credential: { kind: 'key-handle', handleId: 'handle-1' } });

    expect(await created.api.projects.home(result.connectionId!)).toEqual({ ok: true, home: '/home/u', error: null });
    const bootstrap = await created.api.helper.bootstrap(result.connectionId!);
    expect(bootstrap.pocketshell.installed).toBe(false);
    expect(native.execs.some((command) => command.includes('command -v pocketshell'))).toBe(true);
  });

  it('refuses unimplemented and removed work by name instead of pretending', async () => {
    const { created } = platform();
    await expect(created.api.sftp.list('android-1', '/')).rejects.toBeInstanceOf(UnsupportedCapability);
    await expect(created.api.forwards.addManual('android-1', { kind: 'local', listenHost: '', listenPort: 1, destHost: '', destPort: 1 }))
      .rejects.toThrow('forwards.addManual');
    expect(await created.api.forwards.list('android-1')).toEqual([]);
    // Removed by the chat-only cut (D45): present for the frozen type, honest
    // refusals in fact. The turn PTY rides the native verbs, not these.
    await expect(created.api.shell.attachSession({ connectionId: 'android-1', sessionName: 'main' }))
      .rejects.toBeInstanceOf(RemovedCapability);
    await expect(created.api.shell.attachSession({ connectionId: 'android-1', sessionName: 'main' }))
      .rejects.toThrow('in the chat-only cut (D45)');
    await expect(created.api.helper.sessionsList('android-1')).rejects.toBeInstanceOf(RemovedCapability);
    await expect(created.api.helper.usage('android-1')).rejects.toThrow('in the chat-only cut (D45)');
    expect(typeof created.api.shell.onData).toBe('function');
    expect(typeof created.api.shell.onExited).toBe('function');
  });

  it('reports a saved host with no key-vault handle as a dial failure', async () => {
    const { storage, created } = platform();
    storage.setItem(ANDROID_HOSTS_STORAGE_KEY, JSON.stringify([{ name: 'box', hostname: 'box', port: 22, user: 'u' }]));
    const result = await created.api.ssh.connect({ host: 'box', port: 22, user: 'u' });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('No SSH key is chosen for “box”') });
  });

  it('drives the controller grace from Android lifecycle and never feeds the shared resume probe', async () => {
    const { hosts, created, controllers, emitActive } = platform();
    hosts.save({ name: 'fixture', hostname: 'fixture', port: 2222, user: 'u', keyHandleId: 'handle-1' });
    const result = await created.api.ssh.connect({ host: 'fixture', port: 2222, user: 'u' });
    open.push({ hub: created.hub, id: result.connectionId! });
    let resumed = 0;
    created.api.app.onResumed(() => { resumed += 1; });

    emitActive(false);
    await settle(() => controllers.at(-1)!.getSnapshot().phase === 'background');
    emitActive(true);
    await settle(() => controllers.at(-1)!.getSnapshot().phase === 'connected');
    expect(resumed).toBe(0);
  });

  it('mounts the shared app by default unless the launch opted into legacy screens', () => {
    expect(selectShell('')).toBe('shared');
    expect(selectShell('?shell=legacy')).toBe('legacy');
    expect(selectShell('?shell=other')).toBe('shared');
    expect(selectShell('?shell=shared')).toBe('shared');
    const storage = new MemoryStorage();
    recordShellBoot('legacy', storage);
    expect(selectShell('', storage)).toBe('legacy');
    expect(selectShell('?shell=shared', storage)).toBe('shared');
  });

  it('wires win.openNewWindow to openAddHost when supplied', async () => {
    let opened = false;
    const { native, storage } = harness();
    const hosts = new AndroidHostStore({ storage, readLegacyHosts: async () => [] });
    const platform = createAndroidPlatform({
      createController: () => new ConnectionController({
        capability: native.capability(),
        trustStore: createLocalTrustStore(storage),
      }),
      hosts,
      backgroundGraceMs: () => 1000,
      addHostRoute: '/android/hosts',
      openAddHost: async () => { opened = true; },
    });
    expect(typeof platform.api.win?.openNewWindow).toBe('function');
    await platform.api.win?.openNewWindow?.();
    expect(opened).toBe(true);
  });

  it('records each boot so a load-then-reload launch is visible as two entries', () => {
    const storage = new MemoryStorage();
    recordShellBoot('legacy', storage);
    expect(JSON.parse(storage.getItem(SHELL_BOOT_LOG_KEY)!)).toEqual(['legacy']);
    recordShellBoot('shared', storage);
    expect(JSON.parse(storage.getItem(SHELL_BOOT_LOG_KEY)!)).toEqual(['legacy', 'shared']);
  });
});

