// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedHost } from '../../src/platform/android/hostStore';

const vault = vi.hoisted(() => ({ listSshKeys: vi.fn() }));
vi.mock('../../src/native/sshKeyVault', () => ({ listSshKeys: vault.listSshKeys }));
// The editor reaches the shared key manager for its vault sheet; that module
// wires IndexedDB and the native plugin at import time, and this file never
// opens the sheet. `connectionEditorKeySheet.test.ts` covers the sheet itself.
vi.mock('../../src/platform/android/hosts', () => ({ androidKeyManager: {} }));

type Status = 'idle' | 'connecting' | 'connected' | 'error';

interface FakeStore {
  hosts: SavedHost[];
  activeName: string | null;
  status: Status;
  lastError: string | null;
  pendingSwitch: string | null;
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  saveSecret: ReturnType<typeof vi.fn>;
  forgetSecrets: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  requestConnect: ReturnType<typeof vi.fn>;
  confirmSwitch: ReturnType<typeof vi.fn>;
  cancelSwitch: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  applyConnectionSnapshot: ReturnType<typeof vi.fn>;
  setPiSessionsDir: ReturnType<typeof vi.fn>;
  statusFor: (name: string) => 'connected' | 'idle';
}

const storeCell = vi.hoisted(() => ({ current: null as unknown as FakeStore }));
// Only the Pinia wrapper is replaced. `createConnectionsStore` stays real so the
// store-level in-flight guard (4c) is exercised against its actual code, and the
// list-level tests can hand the list a store that seals for real.
vi.mock('../../src/stores/connections', async () => {
  const actual = await vi.importActual<typeof import('../../src/stores/connections')>(
    '../../src/stores/connections',
  );
  return { ...actual, useConnectionsStore: () => storeCell.current };
});

import type { SshHostTarget } from '@pocketshell/core';
import ConnectionEditor from '../../src/components/connections/ConnectionEditor.vue';
import ConnectionsList from '../../src/components/connections/ConnectionsList.vue';
import { redactForLog } from '../../src/credentials/redactForLog';
import { createConnectionsStore } from '../../src/stores/connections';
import type { RememberedSecrets } from '../../src/native/rememberedSecrets';

const PASSWORD_HOST: SavedHost = {
  name: 'pw', hostname: 'h', port: 22, user: 'u', keyHandleId: '',
  auth: { kind: 'password', passwordCredentialId: 'p-1' },
};

const PLAIN_KEY_HOST: SavedHost = {
  name: 'plain', hostname: 'h', port: 22, user: 'u', keyHandleId: 'h-2',
  auth: { kind: 'key', keyHandleId: 'h-2' },
};

const SECRET_KEY_HOST: SavedHost = {
  name: 'keyed', hostname: 'h', port: 22, user: 'u', keyHandleId: 'h-1',
  auth: { kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1' },
};

function fakeStore(hosts: SavedHost[] = []): FakeStore {
  return reactive({
    hosts,
    activeName: null,
    status: 'idle',
    lastError: null,
    pendingSwitch: null,
    load: vi.fn(),
    save: vi.fn(async () => {}),
    saveSecret: vi.fn(async () => {}),
    forgetSecrets: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    requestConnect: vi.fn(async () => {}),
    confirmSwitch: vi.fn(async () => {}),
    cancelSwitch: vi.fn(),
    disconnect: vi.fn(async () => {}),
    applyConnectionSnapshot: vi.fn(),
    setPiSessionsDir: vi.fn(),
    statusFor: () => 'idle',
  }) as unknown as FakeStore;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** A promise the test settles by hand, so "in flight" is a state it controls. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

interface RealStoreHarness {
  store: ReturnType<typeof createConnectionsStore>;
  records: SavedHost[];
  put: ReturnType<typeof vi.fn<RememberedSecrets['put']>>;
  forget: ReturnType<typeof vi.fn<RememberedSecrets['forget']>>;
  hostsSave: ReturnType<typeof vi.fn<(host: SavedHost) => void>>;
  savedHosts: ReturnType<typeof vi.fn<() => SavedHost[]>>;
}

/**
 * The real store over a writable in-memory host list, so a list-level test can
 * assert the seal (the injected `put`) rather than only the store call.
 */
function realStore(records: SavedHost[]): RealStoreHarness {
  const put = vi.fn<RememberedSecrets['put']>(async () => 's-new');
  const forget = vi.fn<RememberedSecrets['forget']>(async () => {});
  const savedHosts = vi.fn<() => SavedHost[]>(() => records);
  const hostsSave = vi.fn<(host: SavedHost) => void>((host) => {
    const index = records.findIndex((entry) => entry.name === host.name);
    if (index >= 0) records[index] = host;
    else records.push(host);
  });
  const store = createConnectionsStore({
    hosts: {
      savedHosts,
      save: hostsSave,
      remove: (name) => {
        const index = records.findIndex((entry) => entry.name === name);
        if (index >= 0) records.splice(index, 1);
      },
      resolve: async (): Promise<SshHostTarget> => ({
        hostId: 'u@h:22',
        hostname: 'h',
        port: 22,
        username: 'u',
        credential: { kind: 'key-handle', handleId: 'h-1', passphrase: null },
      }),
    },
    port: { connect: async () => ({ ok: true }), disconnect: async () => {} },
    secrets: { put, resolve: async () => null, forget },
  });
  return { store, records, put, forget, hostsSave, savedHosts };
}

let live: App[] = [];

function mount(render: () => ReturnType<typeof h>): { app: App; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp(defineComponent({ setup: () => render }));
  app.mount(root);
  live.push(app);
  return { app, root };
}

interface EditorHarness {
  app: App;
  root: HTMLElement;
  save: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

function mountEditor(host: SavedHost | null = null): EditorHarness {
  const state = reactive({ host, error: '' });
  const save = vi.fn();
  const forget = vi.fn();
  const cancel = vi.fn();
  const mounted = mount(() => h(ConnectionEditor, {
    host: state.host,
    error: state.error,
    onSave: save,
    onCancel: cancel,
    onForgetCredentials: forget,
  }));
  return { ...mounted, save, forget, cancel };
}

function mountList(store: FakeStore): { app: App; root: HTMLElement } {
  storeCell.current = store;
  const state = reactive({ open: false });
  return mount(() => h(ConnectionsList, {
    editorOpen: state.open,
    'onUpdate:editorOpen': (open: boolean) => { state.open = open; },
  }));
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  await nextTick();
}

function q(root: HTMLElement, testId: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${testId}"]`);
}

function input(root: HTMLElement, testId: string): HTMLInputElement {
  const found = q(root, testId);
  expect(found, testId).not.toBeNull();
  return found as HTMLInputElement;
}

function saveButton(root: HTMLElement): HTMLButtonElement {
  return root.querySelector('button[type="submit"]') as HTMLButtonElement;
}

/** A field by its visible label, so the test does not depend on input order. */
function labelled(root: HTMLElement, label: string): HTMLInputElement {
  const match = [...root.querySelectorAll('label')]
    .find((entry) => entry.querySelector('span')?.textContent?.trim() === label);
  const found = match?.querySelector('input');
  expect(found, label).not.toBeNull();
  return found as HTMLInputElement;
}

/**
 * A real `input` event bubbles, which is how the form's own `@input` hears an
 * edit and retires a validation problem (R36); the helper must too.
 */
async function typeInto(target: HTMLInputElement, value: string): Promise<void> {
  target.value = value;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

async function choose(target: HTMLSelectElement, value: string): Promise<void> {
  target.value = value;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}

async function setChecked(target: HTMLInputElement, checked: boolean): Promise<void> {
  target.checked = checked;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}

/** The three required fields every new host needs before it can be saved. */
async function fillBasics(root: HTMLElement, name = 'kai'): Promise<void> {
  await typeInto(labelled(root, '名称'), name);
  await typeInto(labelled(root, '主机 / IP'), '192.168.1.3');
  await typeInto(labelled(root, '用户'), 'kai');
}

async function pressSave(root: HTMLElement): Promise<void> {
  saveButton(root).click();
  await settle();
}

async function openEditorFor(root: HTMLElement, host: SavedHost): Promise<void> {
  (root.querySelector(`[aria-label="${host.name} 的更多操作"]`) as HTMLButtonElement).click();
  await settle();
  const edit = [...root.querySelectorAll('[role="menuitem"]')]
    .find((entry) => entry.textContent?.includes('编辑')) as HTMLButtonElement;
  edit.click();
  await settle();
}

describe('connection editor auth', () => {
  beforeEach(() => {
    vault.listSshKeys.mockResolvedValue([{ handleId: 'k-1', label: 'kai@laptop' }]);
  });

  afterEach(() => {
    for (const app of live) app.unmount();
    live = [];
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('switches between the key and password fields', async () => {
    const editor = mountEditor();
    await settle();

    expect(q(editor.root, 'auth-key')?.getAttribute('aria-pressed')).toBe('true');
    expect(editor.root.querySelector('select')).not.toBeNull();
    expect(q(editor.root, 'remember-passphrase')).not.toBeNull();
    expect(q(editor.root, 'password-input')).toBeNull();

    (q(editor.root, 'auth-password') as HTMLButtonElement).click();
    await settle();

    expect(editor.root.querySelector('select')).toBeNull();
    expect(q(editor.root, 'remember-passphrase')).toBeNull();
    const password = input(editor.root, 'password-input');
    expect(password.type).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    expect(q(editor.root, 'remember-password')).not.toBeNull();
  });

  it('keeps save disabled until a key is chosen or a password is typed', async () => {
    const editor = mountEditor();
    await settle();

    expect(saveButton(editor.root).disabled).toBe(true);

    await choose(editor.root.querySelector('select') as HTMLSelectElement, 'k-1');
    expect(saveButton(editor.root).disabled).toBe(false);

    (q(editor.root, 'auth-password') as HTMLButtonElement).click();
    await settle();
    expect(saveButton(editor.root).disabled).toBe(true);

    await typeInto(input(editor.root, 'password-input'), 'pw-typed');
    expect(saveButton(editor.root).disabled).toBe(false);
  });

  it('hands a typed password to save and keeps it off the record', async () => {
    const editor = mountEditor();
    await settle();
    await fillBasics(editor.root);
    (q(editor.root, 'auth-password') as HTMLButtonElement).click();
    await settle();
    await typeInto(input(editor.root, 'password-input'), 'p@ssw0rd-typed');
    await pressSave(editor.root);

    expect(editor.save).toHaveBeenCalledTimes(1);
    const [record, secret] = editor.save.mock.calls[0] as [SavedHost, string | null];
    expect(secret).toBe('p@ssw0rd-typed');
    expect(record.auth).toEqual({ kind: 'password', passwordCredentialId: '' });
    expect(JSON.stringify(record)).not.toContain('p@ssw0rd-typed');
  });

  it('keeps the stored password id and emits the typed secret when 记住密码 is on (R30.1)', async () => {
    const editor = mountEditor(PASSWORD_HOST);
    await settle();
    await typeInto(input(editor.root, 'password-input'), 'fresh-pw');
    expect(input(editor.root, 'remember-password').checked).toBe(true);
    await pressSave(editor.root);

    const [record, secret] = editor.save.mock.calls[0] as [SavedHost, string | null];
    expect(secret).toBe('fresh-pw');
    expect(record.auth).toEqual({ kind: 'password', passwordCredentialId: 'p-1' });
  });

  it('emits no secret and no remember flag when 记住口令 is off (R30.1)', async () => {
    const editor = mountEditor();
    await settle();
    await fillBasics(editor.root);
    await choose(editor.root.querySelector('select') as HTMLSelectElement, 'k-1');
    await typeInto(input(editor.root, 'passphrase-input'), 'new-pass');
    await setChecked(input(editor.root, 'remember-passphrase'), false);
    await pressSave(editor.root);

    const [record, secret] = editor.save.mock.calls[0] as [SavedHost, string | null];
    expect(secret).toBeNull();
    expect(record.auth).toEqual({ kind: 'key', keyHandleId: 'k-1' });
    expect(JSON.stringify(record)).not.toContain('new-pass');
  });

  it('saves the passphrase with rememberPassphrase when 记住口令 is on (R30.1)', async () => {
    const editor = mountEditor();
    await settle();
    await fillBasics(editor.root);
    await choose(editor.root.querySelector('select') as HTMLSelectElement, 'k-1');
    await typeInto(input(editor.root, 'passphrase-input'), 'new-pass');

    expect(input(editor.root, 'remember-passphrase').checked).toBe(true);
    await pressSave(editor.root);

    const [record, secret] = editor.save.mock.calls[0] as [SavedHost, string | null];
    expect(secret).toBe('new-pass');
    expect(record.auth).toEqual({ kind: 'key', keyHandleId: 'k-1', rememberPassphrase: true });
    expect(record.auth).not.toHaveProperty('secretId');
  });

  it('carries a retained secret id through when nothing new is typed (R30.1)', async () => {
    const editor = mountEditor(SECRET_KEY_HOST);
    await settle();
    await setChecked(input(editor.root, 'remember-passphrase'), true);
    await pressSave(editor.root);

    const [record, secret] = editor.save.mock.calls[0] as [SavedHost, string | null];
    expect(secret).toBeNull();
    expect(record.auth).toEqual({
      kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1',
    });
  });

  it('writes an empty password id when 记住密码 is off, without a secret (R30.1)', async () => {
    const editor = mountEditor(PASSWORD_HOST);
    await settle();
    await setChecked(input(editor.root, 'remember-password'), false);
    await pressSave(editor.root);

    const [record, secret] = editor.save.mock.calls[0] as [SavedHost, string | null];
    expect(secret).toBeNull();
    expect(record.auth).toEqual({ kind: 'password', passwordCredentialId: '' });
  });

  it('refuses to save a typed password while 记住密码 is off (4a)', async () => {
    const editor = mountEditor();
    await settle();
    await fillBasics(editor.root);
    (q(editor.root, 'auth-password') as HTMLButtonElement).click();
    await settle();
    await typeInto(input(editor.root, 'password-input'), 'pw-typed');
    await setChecked(input(editor.root, 'remember-password'), false);
    await pressSave(editor.root);

    expect(editor.save).not.toHaveBeenCalled();
    expect(q(editor.root, 'editor-error')?.textContent)
      .toBe('未开启「记住密码」时无法保存新密码，请开启后重试。');
    // The refusal is the signal; the typed value stays visible in the field.
    expect(input(editor.root, 'password-input').value).toBe('pw-typed');
  });

  it('shows the remember hint only while the password toggle is off (4a)', async () => {
    const editor = mountEditor();
    await settle();
    (q(editor.root, 'auth-password') as HTMLButtonElement).click();
    await settle();
    expect(q(editor.root, 'remember-password-hint')).toBeNull();

    await setChecked(input(editor.root, 'remember-password'), false);
    expect(q(editor.root, 'remember-password-hint')?.textContent)
      .toBe('开启「记住密码」后才能保存新密码。');

    (q(editor.root, 'auth-key') as HTMLButtonElement).click();
    await settle();
    expect(q(editor.root, 'remember-password-hint')).toBeNull();

    (q(editor.root, 'auth-password') as HTMLButtonElement).click();
    await settle();
    expect(q(editor.root, 'remember-password-hint')?.textContent)
      .toBe('开启「记住密码」后才能保存新密码。');

    await setChecked(input(editor.root, 'remember-password'), true);
    expect(q(editor.root, 'remember-password-hint')).toBeNull();
  });

  it('keeps the editor open and shows an error when the save rejects (R30.2)', async () => {
    const store = fakeStore([PASSWORD_HOST]);
    store.save.mockRejectedValue(new Error('the store is unavailable'));
    const list = mountList(store);
    await settle();
    await openEditorFor(list.root, PASSWORD_HOST);

    await typeInto(input(list.root, 'password-input'), 'fresh-pw');
    await pressSave(list.root);

    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pw' }), 'pw', 'fresh-pw',
    );
    expect(q(list.root, 'password-input')).not.toBeNull();
    const alert = q(list.root, 'editor-error');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('保存失败');
  });

  it('closes the editor after a save that resolves (R30.2)', async () => {
    const store = fakeStore([PASSWORD_HOST]);
    const list = mountList(store);
    await settle();
    await openEditorFor(list.root, PASSWORD_HOST);
    await pressSave(list.root);

    expect(store.save).toHaveBeenCalledTimes(1);
    expect(q(list.root, 'password-input')).toBeNull();
    expect(list.root.querySelector('h1')?.textContent).toBe('连接');
  });

  it('saves a stale password host with a cleared id when the toggle is off (R30.3)', async () => {
    const store = fakeStore([PASSWORD_HOST]);
    const list = mountList(store);
    await settle();
    await openEditorFor(list.root, PASSWORD_HOST);
    await setChecked(input(list.root, 'remember-password'), false);
    await pressSave(list.root);

    expect(store.save).toHaveBeenCalledTimes(1);
    const call = store.save.mock.calls[0] as [SavedHost, string | null, string | null];
    expect(call[1]).toBe('pw');
    expect(call[2]).toBeNull();
    expect(call[0].auth).toEqual({ kind: 'password', passwordCredentialId: '' });
  });

  it('shows an error and keeps the row when forgetting the credentials fails (R30.4)', async () => {
    const store = fakeStore([PASSWORD_HOST]);
    store.forgetSecrets.mockRejectedValue(new Error('the store is unavailable'));
    const list = mountList(store);
    await settle();
    await openEditorFor(list.root, PASSWORD_HOST);

    (q(list.root, 'forget-credentials') as HTMLButtonElement).click();
    await settle();

    expect(store.forgetSecrets).toHaveBeenCalledWith('pw');
    const alert = q(list.root, 'editor-error');
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('无法清除');

    (list.root.querySelector('[aria-label="取消"]') as HTMLButtonElement).click();
    await settle();
    expect(list.root.querySelector('[aria-label="pw 的更多操作"]')).not.toBeNull();
  });

  it('offers 已保存 and a clear action for a host that holds a password (R30.3)', async () => {
    const editor = mountEditor(PASSWORD_HOST);
    await settle();

    expect(editor.root.textContent).toContain('已保存');
    (q(editor.root, 'forget-credentials') as HTMLButtonElement).click();
    await settle();
    expect(editor.forget).toHaveBeenCalledTimes(1);
  });

  it('drops 已保存 and disables save once a successful clear rewrites the record', async () => {
    const store = fakeStore([PASSWORD_HOST]);
    store.forgetSecrets.mockImplementation(async () => {
      store.hosts[0] = { ...PASSWORD_HOST, auth: { kind: 'password', passwordCredentialId: '' } };
    });
    const list = mountList(store);
    await settle();
    await openEditorFor(list.root, PASSWORD_HOST);
    expect(list.root.textContent).toContain('已保存');
    expect(saveButton(list.root).disabled).toBe(false);

    (q(list.root, 'forget-credentials') as HTMLButtonElement).click();
    await settle();

    expect(store.forgetSecrets).toHaveBeenCalledWith('pw');
    expect(list.root.textContent).not.toContain('已保存');
    expect(q(list.root, 'forget-credentials')).toBeNull();
    expect(saveButton(list.root).disabled).toBe(true);
  });

  it('shows no saved marker for a host that holds no credential', async () => {
    const plain = mountEditor(PLAIN_KEY_HOST);
    await settle();
    expect(plain.root.textContent).not.toContain('已保存');
    expect(q(plain.root, 'forget-credentials')).toBeNull();

    const holding = mountEditor(SECRET_KEY_HOST);
    await settle();
    expect(holding.root.textContent).toContain('已保存');
    expect(q(holding.root, 'forget-credentials')).not.toBeNull();
  });

  it('locks only the rows that reference a stored secret', async () => {
    const list = mountList(fakeStore([PASSWORD_HOST, SECRET_KEY_HOST, PLAIN_KEY_HOST]));
    await settle();

    const locks = [...list.root.querySelectorAll('[data-testid="host-secret-lock"]')];
    expect(locks).toHaveLength(2);
    for (const lock of locks) {
      expect(lock.getAttribute('aria-label')).toBe('已保存凭据');
      expect(lock.querySelector('svg')).not.toBeNull();
    }
    const plainRow = list.root.querySelector('[aria-label="plain 的更多操作"]')?.closest('li');
    expect(plainRow).not.toBeNull();
    expect(plainRow?.querySelector('[data-testid="host-secret-lock"]')).toBeNull();
  });

  it('states a validation problem in Chinese (F4)', async () => {
    const editor = mountEditor();
    await settle();
    await choose(editor.root.querySelector('select') as HTMLSelectElement, 'k-1');
    await pressSave(editor.root);

    const alert = q(editor.root, 'editor-error');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toBe('请填写名称。');
    // Nothing English, and no validator sentence borrowed from the shared app.
    expect(alert?.textContent).not.toMatch(/[A-Za-z]{3,}\s+[A-Za-z]{3,}/);
  });

  it('drops the validation problem as soon as the field is edited (F5, R36)', async () => {
    const editor = mountEditor();
    await settle();
    await choose(editor.root.querySelector('select') as HTMLSelectElement, 'k-1');
    await pressSave(editor.root);
    expect(q(editor.root, 'editor-error')?.textContent).toBe('请填写名称。');

    await typeInto(labelled(editor.root, '名称'), 'kai');

    expect(q(editor.root, 'editor-error')).toBeNull();
    // The form is still incomplete; the next attempt names the next field.
    await pressSave(editor.root);
    expect(q(editor.root, 'editor-error')?.textContent).toBe('请填写主机名或 IP 地址。');
  });

  it('keeps a rejected save from the list in front of a local edit until the save is retried (R36)', async () => {
    const store = fakeStore([PASSWORD_HOST]);
    store.save.mockRejectedValueOnce(new Error('the store is unavailable'));
    const list = mountList(store);
    await settle();
    await openEditorFor(list.root, PASSWORD_HOST);

    await pressSave(list.root);
    expect(q(list.root, 'editor-error')?.textContent).toBe('保存失败，请重试。');

    // Editing is not a retry: the list still owns this failure.
    await typeInto(input(list.root, 'password-input'), 'fresh-pw');
    expect(q(list.root, 'editor-error')?.textContent).toBe('保存失败，请重试。');

    // Retrying is: the failure retires with the attempt that replaced it.
    await pressSave(list.root);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(q(list.root, 'editor-error')).toBeNull();
    expect(q(list.root, 'password-input')).toBeNull();
  });

  it('appends a known Chinese cause to a rejected save (4b)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = fakeStore([PASSWORD_HOST]);
      store.save
        .mockRejectedValueOnce(new Error('Give the host a name.'))
        .mockRejectedValueOnce(new Error('“pw” uses a password credential that is not available yet.'));
      const list = mountList(store);
      await settle();
      await openEditorFor(list.root, PASSWORD_HOST);

      await pressSave(list.root);
      expect(q(list.root, 'editor-error')?.textContent)
        .toBe('保存失败，请重试。 请填写名称。');

      // The store's password-credential refusal is the other known cause.
      await pressSave(list.root);
      expect(q(list.root, 'editor-error')?.textContent)
        .toBe('保存失败，请重试。 「pw」使用的密码凭据尚不可用。');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('shows only the generic line for an unknown cause and logs it redacted (4b)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = fakeStore([PASSWORD_HOST]);
      const secret = 'hunter2';
      store.save.mockRejectedValue(new Error(`keystore refused: passphrase=${secret}`));
      const list = mountList(store);
      await settle();
      await openEditorFor(list.root, PASSWORD_HOST);

      await pressSave(list.root);

      expect(q(list.root, 'editor-error')?.textContent).toBe('保存失败，请重试。');
      expect(consoleError).toHaveBeenCalledTimes(1);
      const logged = String(consoleError.mock.calls[0]?.[0] ?? '');
      expect(logged).toContain('Error: keystore refused');
      expect(logged).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('redacts private-key material from a log line (4b)', () => {
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const base64Run = 'QWxleGV5U2VjcmV0MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1A=';
    const hexRun = 'deadbeef'.repeat(8);
    const logged = redactForLog(new TypeError(
      `vault failed: ${pem} passphrase=hunter2 sealed=${base64Run} key=${hexRun}`,
    ));

    expect(logged).toContain('TypeError');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('OPENSSH PRIVATE KEY');
    expect(logged).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW');
    expect(logged).not.toContain(base64Run);
    expect(logged).not.toContain(hexRun);
    expect(logged).toContain('passphrase=<redacted>');
  });

  it('redacts quoted secrets with spaces and JSON-shaped keys (4b)', () => {
    const cases: Array<[string, string[]]> = [
      ['passphrase="correct horse battery staple"', ['correct', 'horse', 'battery', 'staple']],
      ["passphrase='my secret words'", ['my secret words', 'words']],
      ['passphrase: "two words"', ['two words', 'words']],
      ['{"passphrase":"my secret phrase"}', ['my secret phrase', 'secret phrase']],
      // A JSON key that does not itself contain "phrase", so the value word can
      // be asserted without matching the preserved key.
      ['{"secret":"my secret phrase"}', ['secret phrase', 'phrase']],
    ];
    for (const [message, leaked] of cases) {
      const logged = redactForLog(new Error(message));
      expect(logged, message).toContain('<redacted>');
      for (const word of leaked) expect(logged, `${message} leaked ${word}`).not.toContain(word);
    }
  });

  it('redacts through escaped quotes without leaking the tail (4b)', () => {
    const cases: Array<[string, string]> = [
      ['passphrase="\\"hunter2"', 'hunter2'],
      ['{"passphrase":"\\"hunter2"}', 'hunter2'],
      ["passphrase='\\'hunter2'", 'hunter2'],
      ['{"passphrase":"my \\"secret\\" phrase"}', 'secret'],
      ['password="alpha \\" beta"', 'beta'],
    ];
    for (const [message, tail] of cases) {
      const logged = redactForLog(new Error(message));
      expect(logged, message).toContain('<redacted>');
      expect(logged, `${message} leaked ${tail}`).not.toContain(tail);
    }
  });

  it('never throws when a value cannot be converted to a string (4b)', () => {
    const nullPrototype = Object.create(null);
    const throwingToString = {
      toString: () => {
        throw new TypeError('no string for you');
      },
    };

    for (const value of [nullPrototype, throwingToString]) {
      const logged = redactForLog(value);
      expect(typeof logged).toBe('string');
      expect(logged).toBe('UnknownError: <unrepresentable>');
    }

    const error = new Error('placeholder');
    error.name = 'UnrepresentableMessageError';
    Object.defineProperty(error, 'message', { value: throwingToString, configurable: true });
    const logged = redactForLog(error);
    expect(typeof logged).toBe('string');
    expect(logged).toBe('UnrepresentableMessageError: <unrepresentable>');
  });

  it('never throws when an Error message is not a string (4b)', () => {
    function withMessage(name: string, message: unknown): Error {
      const error = new Error('placeholder');
      error.name = name;
      Object.defineProperty(error, 'message', { value: message, configurable: true });
      return error;
    }
    const cases = [
      withMessage('NullMessageError', null),
      withMessage('UndefinedMessageError', undefined),
      withMessage('ObjectMessageError', { secret: 'hunter2' }),
    ];
    for (const error of cases) {
      const logged = redactForLog(error);
      expect(typeof logged).toBe('string');
      expect(logged.startsWith(`${error.name}: `)).toBe(true);
      expect(logged).not.toContain('hunter2');
    }
  });

  it('redacts at the 32-character material threshold and keeps short words (4b)', () => {
    const hex32 = 'deadbeef'.repeat(4);
    const base64Run39 = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t';
    const logged = redactForLog(new Error(`hex=${hex32} b64=${base64Run39} code=ECONNREFUSED`));

    expect(logged).not.toContain(hex32);
    expect(logged).not.toContain(base64Run39);
    expect(logged).toContain('ECONNREFUSED');
  });

  it('closes the editor and clears the error after a retried save succeeds (4b)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = fakeStore([PASSWORD_HOST]);
      store.save.mockRejectedValueOnce(new Error('the store is unavailable'));
      const list = mountList(store);
      await settle();
      await openEditorFor(list.root, PASSWORD_HOST);

      await pressSave(list.root);
      expect(q(list.root, 'editor-error')?.textContent).toBe('保存失败，请重试。');

      await pressSave(list.root);

      expect(store.save).toHaveBeenCalledTimes(2);
      expect(q(list.root, 'editor-error')).toBeNull();
      expect(q(list.root, 'password-input')).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not let a stale list error mask a locally refused save (4b, R36)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = fakeStore([PASSWORD_HOST]);
      store.save.mockRejectedValueOnce(new Error('Give the host a name.'));
      const list = mountList(store);
      await settle();
      await openEditorFor(list.root, PASSWORD_HOST);

      await pressSave(list.root);
      expect(q(list.root, 'editor-error')?.textContent).toBe('保存失败，请重试。 请填写名称。');

      await setChecked(input(list.root, 'remember-password'), false);
      await typeInto(input(list.root, 'password-input'), 'fresh-pw');
      await pressSave(list.root);

      expect(store.save).toHaveBeenCalledTimes(1);
      expect(q(list.root, 'editor-error')?.textContent)
        .toBe('未开启「记住密码」时无法保存新密码，请开启后重试。');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('carries a known cause through a failed clear and logs an unknown one redacted (4b)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = fakeStore([PASSWORD_HOST]);
      store.forgetSecrets.mockRejectedValueOnce(new Error('Enter the SSH user.'));
      const list = mountList(store);
      await settle();
      await openEditorFor(list.root, PASSWORD_HOST);

      (q(list.root, 'forget-credentials') as HTMLButtonElement).click();
      await settle();
      expect(q(list.root, 'editor-error')?.textContent)
        .toBe('无法清除已保存凭据，请重试。 请填写登录用户。');

      consoleError.mockClear();
      store.forgetSecrets.mockRejectedValueOnce(new Error('keystore down passphrase=hunter2'));
      (q(list.root, 'forget-credentials') as HTMLButtonElement).click();
      await settle();

      expect(q(list.root, 'editor-error')?.textContent).toBe('无法清除已保存凭据，请重试。');
      expect(consoleError).toHaveBeenCalledTimes(1);
      const logged = String(consoleError.mock.calls[0]?.[0] ?? '');
      expect(logged).toContain('Error: keystore down');
      expect(logged).not.toContain('hunter2');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('runs one save and one seal on a double tap of 保存 (4c)', async () => {
    const seal = deferred<string>();
    const real = realStore([PASSWORD_HOST]);
    real.put.mockImplementation(() => seal.promise);
    const saveSpy = vi.spyOn(real.store, 'save');
    const list = mountList(real.store as unknown as FakeStore);
    await settle();
    await openEditorFor(list.root, PASSWORD_HOST);
    await typeInto(input(list.root, 'password-input'), 'fresh-pw');

    const button = saveButton(list.root);
    button.click();
    button.click();
    await settle();

    // One call is not enough evidence: the store must also have sealed once.
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(real.put).toHaveBeenCalledTimes(1);

    seal.resolve('s-sealed');
    await settle();

    expect(real.hostsSave).toHaveBeenCalledTimes(1);
    expect(real.forget).toHaveBeenCalledWith('p-1');
  });

  it('runs one clear on a double tap of 清除 (4c)', async () => {
    const cleared = deferred<void>();
    const real = realStore([PASSWORD_HOST]);
    real.forget.mockImplementation(() => cleared.promise);
    const forgetSpy = vi.spyOn(real.store, 'forgetSecrets');
    const list = mountList(real.store as unknown as FakeStore);
    await settle();
    await openEditorFor(list.root, PASSWORD_HOST);

    const button = q(list.root, 'forget-credentials') as HTMLButtonElement;
    button.click();
    button.click();
    await settle();

    expect(forgetSpy).toHaveBeenCalledTimes(1);
    expect(real.forget).toHaveBeenCalledTimes(1);

    cleared.resolve(undefined);
    await settle();

    expect(real.hostsSave).toHaveBeenCalledTimes(1);
  });

  it('ignores a save that starts while a clear is still in flight (4c)', async () => {
    const cleared = deferred<void>();
    const real = realStore([PASSWORD_HOST]);
    real.forget.mockImplementation(() => cleared.promise);
    real.store.load();
    real.savedHosts.mockClear();

    const clearing = real.store.forgetSecrets('pw');
    // The record and the secret id would interleave here: the clear is about to
    // rewrite the record, and a save landing between the two writes could point
    // the record at the id the clear forgets. One mutation at a time.
    await real.store.save({ ...PASSWORD_HOST, name: 'pw-2' }, 'pw', 'fresh-pw');

    expect(real.put).not.toHaveBeenCalled();
    expect(real.hostsSave).toHaveBeenCalledTimes(0);

    cleared.resolve(undefined);
    await clearing;

    expect(real.hostsSave).toHaveBeenCalledTimes(1);
    expect(real.put).not.toHaveBeenCalled();
  });

  it('releases the in-flight guard after a failed save so a retry runs (4c)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = fakeStore([PASSWORD_HOST]);
      store.save.mockRejectedValueOnce(new Error('the store is unavailable'));
      const list = mountList(store);
      await settle();
      await openEditorFor(list.root, PASSWORD_HOST);

      await pressSave(list.root);
      expect(store.save).toHaveBeenCalledTimes(1);
      expect(q(list.root, 'editor-error')?.textContent).toBe('保存失败，请重试。');
      expect(q(list.root, 'editor-busy-hint')).toBeNull();

      // The guard must release on failure; latching would strand the user.
      await pressSave(list.root);

      expect(store.save).toHaveBeenCalledTimes(2);
      expect(q(list.root, 'editor-error')).toBeNull();
      expect(q(list.root, 'password-input')).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('seals once when the store itself is called twice concurrently (4c)', async () => {
    const seal = deferred<string>();
    const real = realStore([PASSWORD_HOST]);
    real.put.mockImplementation(() => seal.promise);
    real.store.load();
    real.savedHosts.mockClear();

    const next: SavedHost = { ...PASSWORD_HOST, name: 'pw-2' };
    const first = real.store.save(next, 'pw', 'fresh-pw');
    const second = real.store.save(next, 'pw', 'fresh-pw');

    // previousRecords is read before the seal: one save probes the deps twice.
    // The second call returns before that read, so four probes means the guard
    // let a second save get as far as the orphan.
    expect(real.savedHosts).toHaveBeenCalledTimes(2);
    expect(real.put).toHaveBeenCalledTimes(1);

    seal.resolve('s-sealed');
    await Promise.all([first, second]);

    expect(real.put).toHaveBeenCalledTimes(1);
    expect(real.hostsSave).toHaveBeenCalledTimes(1);
    const written = real.hostsSave.mock.calls[0][0];
    // The one sealed id is the id the written record reads: no orphan.
    expect(written.auth).toEqual({ kind: 'password', passwordCredentialId: 's-sealed' });
    expect(real.forget).toHaveBeenCalledWith('p-1');
  });

  it('disables 保存 and 清除 and shows the busy hint while an action is in flight (4c)', async () => {
    const pending = deferred<void>();
    const store = fakeStore([PASSWORD_HOST]);
    store.save.mockImplementation(() => pending.promise);
    const list = mountList(store);
    await settle();
    await openEditorFor(list.root, PASSWORD_HOST);

    await pressSave(list.root);

    expect(saveButton(list.root).disabled).toBe(true);
    expect((q(list.root, 'forget-credentials') as HTMLButtonElement).disabled).toBe(true);
    expect(q(list.root, 'editor-busy-hint')?.textContent).toBe('正在处理，请稍候。');

    pending.resolve(undefined);
    await settle();
  });
});
