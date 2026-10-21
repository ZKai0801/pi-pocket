// @vitest-environment jsdom
import { computed, createApp, defineComponent, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshKeyMetadata } from '../../src/native/sshKeyVault';
import type { SavedHost } from '../../src/platform/android/hostStore';
import editorSource from '../../src/components/connections/ConnectionEditor.vue?raw';

const vault = vi.hoisted(() => ({ listSshKeys: vi.fn() }));
vi.mock('../../src/native/sshKeyVault', () => ({ listSshKeys: vault.listSshKeys }));

/**
 * The one shared manager (`src/platform/android/hosts.ts`) stands in for the
 * real one: the editor must reach it through that module, never construct a
 * second manager (R32), so every call the sheet makes lands on these spies.
 */
const manager = vi.hoisted(() => ({
  generate: vi.fn(),
  importText: vi.fn(),
  pickAndImport: vi.fn(),
  publicKey: vi.fn(),
  copyPublicKey: vi.fn(),
  sharePublicKey: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../src/platform/android/hosts', () => ({ androidKeyManager: manager }));

interface FakeStore {
  hosts: SavedHost[];
  activeName: string | null;
  status: 'idle' | 'connected';
  lastError: string | null;
  pendingSwitch: string | null;
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  forgetSecrets: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  requestConnect: ReturnType<typeof vi.fn>;
  statusFor: (name: string) => 'connected' | 'idle';
}

const storeCell = vi.hoisted(() => ({ current: null as unknown as FakeStore }));
vi.mock('../../src/stores/connections', () => ({ useConnectionsStore: () => storeCell.current }));

import ConnectionsList from '../../src/components/connections/ConnectionsList.vue';
import {
  clearViews,
  createBackStack,
  createShellBackNavigation,
  type BackNavigationOwner,
  type BackStack,
} from '../../src/phone/backNavigation';

const RETIRED = 'k-9';

function metadata(handleId = RETIRED, label = 'kai@laptop'): SshKeyMetadata {
  return {
    handleId,
    label,
    algorithm: 'ssh-ed25519',
    fingerprintSha256: 'SHA256:test',
    passphraseRequired: false,
    createdAt: 0,
  };
}

function fakeStore(hosts: SavedHost[] = []): FakeStore {
  return {
    hosts,
    activeName: null,
    status: 'idle',
    lastError: null,
    pendingSwitch: null,
    load: vi.fn(),
    save: vi.fn(async () => {}),
    forgetSecrets: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    requestConnect: vi.fn(async () => {}),
    statusFor: () => 'idle',
  };
}

let live: App[] = [];

interface Shell {
  root: HTMLElement;
  stack: BackStack;
  back: BackNavigationOwner;
}

/**
 * The 连接 tab as the shell renders it: the pushed view decides, so a key
 * sheet on top of the editor must not unset `editor-open` and unmount the
 * form. These two derivations and the two handlers mirror `PhoneApp.vue`;
 * `phoneShellWiring.test.ts` pins the shell's own copy of them.
 */
function mountShell(hosts: SavedHost[] = []): Shell {
  storeCell.current = fakeStore(hosts);
  const stack = createBackStack({ getActiveTab: () => 'connections' });
  const back = createShellBackNavigation({
    stack,
    getActiveTab: () => 'connections',
    closeOverlay: () => false,
  });
  const view = computed(() => stack.current('connections'));

  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp(defineComponent({
    setup: () => () => h(ConnectionsList, {
      editorOpen: view.value !== null,
      keysOpen: view.value === 'keys',
      'onUpdate:editorOpen': (open: boolean) => {
        if (open) {
          stack.push('connections', 'editor');
          return;
        }
        clearViews(stack, 'connections');
      },
      'onUpdate:keysOpen': (open: boolean) => {
        if (open) {
          if (stack.current('connections') !== 'keys') stack.push('connections', 'keys');
          return;
        }
        if (stack.current('connections') === 'keys') stack.pop('connections');
      },
    }),
  }));
  app.mount(root);
  live.push(app);
  return { root, stack, back };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  await nextTick();
}

/** Teleported to the body, so the sheet is queried from the document. */
function q(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function press(testId: string): void {
  const found = q(testId);
  expect(found, testId).not.toBeNull();
  (found as HTMLButtonElement).click();
}

async function openEditor(shell: Shell): Promise<void> {
  shell.stack.push('connections', 'editor');
  await settle();
}

async function openSheet(shell: Shell): Promise<void> {
  press('open-key-sheet');
  await settle();
}

/** The list's own edit path, so the editor starts from a saved record. */
async function openExistingHost(shell: Shell, host: SavedHost): Promise<void> {
  const more = shell.root.querySelector(`[aria-label="${host.name} 的更多操作"]`) as HTMLButtonElement;
  expect(more, host.name).not.toBeNull();
  more.click();
  await settle();
  const edit = [...shell.root.querySelectorAll('[role="menuitem"]')]
    .find((entry) => entry.textContent?.includes('编辑')) as HTMLButtonElement;
  edit.click();
  await settle();
}

describe('connection editor key sheet', () => {
  beforeEach(() => {
    vault.listSshKeys.mockResolvedValue([]);
    manager.publicKey.mockResolvedValue('ssh-ed25519 AAAA test');
  });

  afterEach(() => {
    for (const app of live) app.unmount();
    live = [];
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('replaces the dead key-page hint with a control that opens the vault sheet (R33)', async () => {
    const shell = mountShell();
    await openEditor(shell);

    expect(q('keys-empty-hint')?.textContent).not.toContain('密钥页');
    expect(q('ssh-key-sheet')).toBeNull();

    press('open-key-sheet');
    await settle();

    expect(q('ssh-key-sheet')).not.toBeNull();
    // The one shared vault screen, not a copy of it (R32).
    expect(q('ssh-keys-screen')).not.toBeNull();
    expect(q('close-ssh-key-sheet')).not.toBeNull();
  });

  it('writes the key chosen in the sheet into the editor and returns to it', async () => {
    let stored: SshKeyMetadata[] = [];
    vault.listSshKeys.mockImplementation(async () => stored);
    const shell = mountShell();
    await openEditor(shell);
    await openSheet(shell);

    manager.generate.mockImplementation(async () => {
      stored = [metadata()];
      return metadata();
    });
    press('ssh-key-generate-tab');
    await settle();
    press('generate-ssh-key');
    await settle();

    expect(manager.generate).toHaveBeenCalledTimes(1);
    press(`select-ssh-key-${RETIRED}`);
    await settle();

    expect(q('ssh-key-sheet')).toBeNull();
    const select = shell.root.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe(RETIRED);
    expect((shell.root.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('re-lists the vault on refresh so a newly generated key reaches the editor select', async () => {
    let stored: SshKeyMetadata[] = [];
    vault.listSshKeys.mockImplementation(async () => stored);
    const shell = mountShell();
    await openEditor(shell);
    await openSheet(shell);

    expect(q('ssh-key-empty')).not.toBeNull();
    manager.generate.mockImplementation(async () => {
      stored = [metadata()];
      return metadata();
    });
    press('ssh-key-generate-tab');
    await settle();
    press('generate-ssh-key');
    await settle();

    expect(vault.listSshKeys).toHaveBeenCalledTimes(2);
    // `stay` keeps the sheet open: a fresh key shows its public half there.
    expect(q('ssh-key-sheet')).not.toBeNull();
    expect(q(`ssh-key-${RETIRED}`)).not.toBeNull();

    press('close-ssh-key-sheet');
    await settle();

    const select = shell.root.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toContain(RETIRED);
  });

  it('keeps the vault reachable and replaces the handle when the vault already holds keys (F3)', async () => {
    const stored = [metadata('k-1'), metadata('k-2', 'work@desk')];
    vault.listSshKeys.mockImplementation(async () => stored);
    const host: SavedHost = {
      name: 'kai', hostname: 'h', port: 22, user: 'u', keyHandleId: 'k-1',
      auth: { kind: 'key', keyHandleId: 'k-1' },
    };
    const shell = mountShell([host]);
    await settle();
    await openExistingHost(shell, host);

    expect((shell.root.querySelector('select') as HTMLSelectElement).value).toBe('k-1');
    // A stored key hides the empty-state control, not the vault itself.
    expect(q('keys-empty')).toBeNull();
    expect(q('manage-keys')).not.toBeNull();

    press('manage-keys');
    await settle();

    expect(q('ssh-key-sheet')).not.toBeNull();
    press('select-ssh-key-k-2');
    await settle();

    expect(q('ssh-key-sheet')).toBeNull();
    expect((shell.root.querySelector('select') as HTMLSelectElement).value).toBe('k-2');
    (shell.root.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await settle();
    expect((storeCell.current.save.mock.calls[0] as [SavedHost])[0].keyHandleId).toBe('k-2');
  });

  it('closes the sheet before the editor when Back is pressed (R34)', async () => {
    const shell = mountShell();
    await openEditor(shell);
    await openSheet(shell);

    expect(shell.back.handleBack()).toBe(true);
    await settle();

    expect(q('ssh-key-sheet')).toBeNull();
    expect(shell.stack.current('connections')).toBe('editor');
    // The editor is still mounted with its form intact behind the closed sheet.
    expect(shell.root.querySelector('form')).not.toBeNull();
    expect(q('keys-empty-hint')).not.toBeNull();
  });

  it('puts the sheet bar outside the DOM scroll region and declares a fixed layer between z-index 20 and 30', async () => {
    const shell = mountShell();
    await openEditor(shell);
    await openSheet(shell);

    const sheet = q('ssh-key-sheet') as HTMLElement;
    const bar = q('ssh-key-sheet-header') as HTMLElement;
    const body = q('ssh-key-sheet-body') as HTMLElement;

    // Teleported out of `.phone-shell__content` (overflow: hidden, clipped).
    expect(sheet.parentElement).toBe(document.body);
    // The 返回 control is a sibling of the scroller, never inside it.
    expect(body.contains(bar)).toBe(false);
    expect(bar.nextElementSibling).toBe(body);
    expect(bar.contains(q('close-ssh-key-sheet'))).toBe(true);
    // The scroller really is the vault screen, bounded by the body box.
    expect(body.querySelector('[data-testid="ssh-keys-screen"]')).not.toBeNull();

    // Keyword guard on the stylesheet only: jsdom has no layout, so this says
    // what the file declares, not that the layer is reachable on a device.
    // Reachability is proved by the packaged-app walk (Task 4).
    const sheetRule = editorSource.slice(
      editorSource.indexOf('.connection-editor__keys-sheet {'),
      editorSource.indexOf('}', editorSource.indexOf('.connection-editor__keys-sheet {')),
    );
    expect(sheetRule).toContain('position: fixed');
    const zIndex = Number(/z-index:\s*(\d+)/.exec(sheetRule)?.[1]);
    // Above `.AppTabBar` (z-index 20), below the terminal (30) and trust (40).
    expect(zIndex).toBeGreaterThan(20);
    expect(zIndex).toBeLessThan(30);
  });
});
