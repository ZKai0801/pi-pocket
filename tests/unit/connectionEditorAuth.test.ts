// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedHost } from '../../src/platform/android/hostStore';

const vault = vi.hoisted(() => ({ listSshKeys: vi.fn() }));
vi.mock('../../src/native/sshKeyVault', () => ({ listSshKeys: vault.listSshKeys }));

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
vi.mock('../../src/stores/connections', () => ({ useConnectionsStore: () => storeCell.current }));

import ConnectionEditor from '../../src/components/connections/ConnectionEditor.vue';
import ConnectionsList from '../../src/components/connections/ConnectionsList.vue';

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
  return {
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
  } as unknown as FakeStore;
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

async function typeInto(target: HTMLInputElement, value: string): Promise<void> {
  target.value = value;
  target.dispatchEvent(new Event('input'));
  await nextTick();
}

async function choose(target: HTMLSelectElement, value: string): Promise<void> {
  target.value = value;
  target.dispatchEvent(new Event('change'));
  await nextTick();
}

async function setChecked(target: HTMLInputElement, checked: boolean): Promise<void> {
  target.checked = checked;
  target.dispatchEvent(new Event('change'));
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
});
