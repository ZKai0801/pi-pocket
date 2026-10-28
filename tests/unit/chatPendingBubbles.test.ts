// @vitest-environment jsdom
import { createApp, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reader's own lines that the session file does not carry yet: what the
 * transcript shows next to the bubble while the line is travelling, and how a
 * line that never arrived comes back to the composer.
 */
const mocks = vi.hoisted(() => ({
  sessions: {
    lastProject: { path: '/p/a', name: 'a' } as { path: string; name: string } | null,
    sessions: [] as Array<Record<string, unknown>>,
    state: 'ready' as string,
    error: null as string | null,
    stale: false,
    open: null as Record<string, unknown> | null,
    openPath: '/r/a.jsonl' as string | null,
    openRunning: false,
    sending: false,
    sendError: null as string | null,
    sendNotice: null as string | null,
    running: [] as string[],
    selecting: false,
    selected: [] as string[],
    deleting: false,
    deleteError: null as string | null,
    startSelection: vi.fn(),
    toggleSelected: vi.fn(),
    setAllSelected: vi.fn(),
    cancelSelection: vi.fn(),
    deleteSelected: vi.fn(async () => 0),
    pending: [] as Array<Record<string, unknown>>,
    modelNotes: [] as Array<Record<string, unknown>>,
    commandNotes: [] as Array<Record<string, unknown>>,
    pendingDialog: null as Record<string, unknown> | null,
    dialogAnswering: false,
    answerPendingDialog: vi.fn(async () => {}),
    newConversation: vi.fn(),
    load: vi.fn(async () => {}),
    openSession: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    send: vi.fn(async () => 'sent' as const),
    closeChat: vi.fn(),
    retryPending: vi.fn(() => null as string | null),
  },
  /** What the composer was handed, in order: the words of a failed line. */
  composerTexts: [] as string[],
}));

vi.mock('../../src/stores/sessions', () => ({
  useSessionsStore: () => mocks.sessions,
  projectBasename: (path: string) => path.slice(path.lastIndexOf('/') + 1),
  relativeTime: () => '刚刚',
}));

vi.mock('../../src/stores/projects', () => ({
  useProjectsStore: () => ({ selected: '/p/a' }),
}));

vi.mock('../../src/stores/connections', () => ({
  useConnectionsStore: () => ({ activeName: null, hosts: [] }),
}));

vi.mock('@ui/components/AppIcon.vue', () => ({ default: { render: () => null } }));

// The composer's own behaviour is tested elsewhere; here it only has to take
// the words back when the reader asks for them.
vi.mock('../../src/components/sessions/ChatComposer.vue', () => ({
  default: {
    setup(_props: unknown, { expose }: { expose: (api: unknown) => void }) {
      expose({ setText: (value: string): void => void mocks.composerTexts.push(value) });
      return () => null;
    },
  },
}));

import ChatScreen from '../../src/components/sessions/ChatScreen.vue';

let app: App | null = null;
let root: HTMLElement | null = null;

function mount(): HTMLElement {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(ChatScreen as never);
  app.mount(root);
  return root;
}

function ghost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    text: 'hello',
    kind: 'send',
    afterUserTurns: 1,
    status: 'sending',
    ...overrides,
  };
}

function click(el: HTMLElement, testId: string): void {
  const node = el.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (node === null) throw new Error(`no ${testId}`);
  node.click();
}

function visible(el: HTMLElement, testId: string): boolean {
  return el.querySelector(`[data-testid="${testId}"]`) !== null;
}

describe('chat pending bubbles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.composerTexts = [];
    mocks.sessions.open = {
      version: 3,
      id: 'a',
      cwd: '/p/a',
      name: null,
      turns: [{ role: 'user', text: 'one', timestampMs: 0 }],
    };
    mocks.sessions.openPath = '/r/a.jsonl';
    mocks.sessions.modelNotes = [];
    mocks.sessions.commandNotes = [];
    mocks.sessions.pending = [];
    mocks.sessions.lastProject = { path: '/p/a', name: 'a' };
    mocks.sessions.retryPending.mockReturnValue(null);
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    root = null;
    document.body.innerHTML = '';
  });

  it('spins next to a line that is still travelling', () => {
    mocks.sessions.pending = [ghost()];

    const el = mount();

    expect(visible(el, 'chat-pending-spinner')).toBe(true);
    expect(visible(el, 'chat-pending-failed')).toBe(false);
    expect(el.querySelector('.chat__pending')?.classList.contains('chat__pending--sending')).toBe(true);
  });

  it('stops spinning once Pi has the line, and shows nothing at all then', () => {
    mocks.sessions.pending = [ghost({ status: 'sent' })];

    const el = mount();

    expect(visible(el, 'chat-pending-spinner')).toBe(false);
    expect(visible(el, 'chat-pending-failed')).toBe(false);
    expect(el.querySelector('.chat__pending')?.classList.contains('chat__pending--sending')).toBe(false);
  });

  it('marks a line that never arrived, and asks before handing it back', async () => {
    mocks.sessions.pending = [ghost({ status: 'failed' })];

    const el = mount();
    expect(visible(el, 'chat-pending-spinner')).toBe(false);
    expect(visible(el, 'chat-resend')).toBe(false);

    click(el, 'chat-pending-failed');
    await Promise.resolve();

    // The question names the line, so the reader knows which one it is about.
    expect(visible(el, 'chat-resend')).toBe(true);
    expect(el.querySelector('[data-testid="chat-resend"]')?.textContent).toContain('hello');
    expect(mocks.sessions.retryPending).not.toHaveBeenCalled();

    click(el, 'chat-resend-confirm');
    await Promise.resolve();

    expect(mocks.sessions.retryPending).toHaveBeenCalledWith('p1');
  });

  it('puts the failed line in the composer and leaves the words alone when cancelled', async () => {
    mocks.sessions.pending = [ghost({ status: 'failed' })];
    mocks.sessions.retryPending.mockImplementation(() => {
      mocks.sessions.pending = [];
      return 'hello';
    });

    const el = mount();
    click(el, 'chat-pending-failed');
    await Promise.resolve();

    click(el, 'chat-resend-cancel');
    await Promise.resolve();

    expect(mocks.sessions.retryPending).not.toHaveBeenCalled();
    expect(mocks.composerTexts).toEqual([]);
    // Cancelling leaves the bubble where it was: the line is still unread.
    expect(mocks.sessions.pending).toHaveLength(1);

    click(el, 'chat-pending-failed');
    await Promise.resolve();
    click(el, 'chat-resend-confirm');
    await Promise.resolve();

    expect(mocks.composerTexts).toEqual(['hello']);
    expect(visible(el, 'chat-resend')).toBe(false);
  });

  it('says nothing about a line the store has already taken back', async () => {
    mocks.sessions.pending = [ghost({ status: 'failed' })];
    // Nothing comes back: the bubble went with the words.
    mocks.sessions.retryPending.mockReturnValue(null);

    const el = mount();
    click(el, 'chat-pending-failed');
    await Promise.resolve();
    click(el, 'chat-resend-confirm');
    await Promise.resolve();

    expect(mocks.composerTexts).toEqual([]);
    expect(visible(el, 'chat-resend')).toBe(false);
  });
});
