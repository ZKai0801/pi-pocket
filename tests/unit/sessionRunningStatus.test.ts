// @vitest-environment jsdom
import { createApp, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: {
    lastProject: { path: '/p/a', name: 'a' } as { path: string; name: string } | null,
    sessions: [] as Array<Record<string, unknown>>,
    state: 'ready' as string,
    error: null as string | null,
    open: null as Record<string, unknown> | null,
    openRunning: false,
    sending: false,
    sendError: null as string | null,
    running: [] as string[],
    pending: [] as Array<Record<string, unknown>>,
    newConversation: vi.fn(),
    load: vi.fn(async () => {}),
    openSession: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    send: vi.fn(async () => 'sent' as const),
    closeChat: vi.fn(),
  },
}));

vi.mock('../../src/stores/sessions', () => ({
  useSessionsStore: () => mocks.sessions,
  projectBasename: (path: string) => path.slice(path.lastIndexOf('/') + 1),
  relativeTime: () => '刚刚',
}));

vi.mock('../../src/stores/projects', () => ({
  useProjectsStore: () => ({ selected: '/p/a' }),
}));

// The chat resolves pi's path against the active host for the 「+」 command
// sheet, so it needs the connections store too.
vi.mock('../../src/stores/connections', () => ({
  useConnectionsStore: () => ({ activeName: null, hosts: [] }),
}));

vi.mock('@ui/components/AppIcon.vue', () => ({ default: { render: () => null } }));
vi.mock('../../src/components/sessions/ChatBubble.vue', () => ({ default: { render: () => null } }));
vi.mock('../../src/components/sessions/ChatComposer.vue', () => ({ default: { render: () => null } }));

import SessionList from '../../src/components/sessions/SessionList.vue';
import ChatScreen from '../../src/components/sessions/ChatScreen.vue';

let app: App | null = null;
let root: HTMLElement | null = null;

function mount(component: unknown): HTMLElement {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(component as never);
  app.mount(root);
  return root;
}

function sessionRow(path: string): Record<string, unknown> {
  return { path, id: path, name: null, updatedAtMs: 1, preview: 'hello', turnCount: 1 };
}

describe('sessions running status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions.sessions = [];
    mocks.sessions.running = [];
    mocks.sessions.open = null;
    mocks.sessions.openRunning = false;
    mocks.sessions.pending = [];
    mocks.sessions.lastProject = { path: '/p/a', name: 'a' };
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    root = null;
    document.body.innerHTML = '';
  });

  it('marks the running row with a pulse and leaves the others plain', () => {
    mocks.sessions.sessions = [sessionRow('/r/a.jsonl'), sessionRow('/r/b.jsonl')];
    mocks.sessions.running = ['/r/b.jsonl'];

    const el = mount(SessionList);

    const pulses = el.querySelectorAll('[data-testid="session-running"]');
    expect(pulses).toHaveLength(1);
    expect(pulses[0]?.getAttribute('data-running')).toBe('/r/b.jsonl');
    expect(pulses[0]?.getAttribute('aria-label')).toBe('正在运行');
  });

  it('marks every running row at once', () => {
    mocks.sessions.sessions = [sessionRow('/r/a.jsonl'), sessionRow('/r/b.jsonl')];
    mocks.sessions.running = ['/r/a.jsonl', '/r/b.jsonl'];

    const el = mount(SessionList);

    expect(el.querySelectorAll('[data-testid="session-running"]')).toHaveLength(2);
  });

  it('shows the running copy instead of the chat title while a turn is in flight', () => {
    mocks.sessions.open = { version: 3, id: 'a', cwd: '/p/a', name: 'named chat', turns: [] };
    mocks.sessions.openRunning = true;

    const el = mount(ChatScreen);
    const title = el.querySelector('.chat__title');

    expect(title?.textContent?.trim()).toBe('正在运行…');
  });

  it('shows the chat name once the turn is finished', () => {
    mocks.sessions.open = { version: 3, id: 'a', cwd: '/p/a', name: 'named chat', turns: [] };
    mocks.sessions.openRunning = false;

    const el = mount(ChatScreen);

    expect(el.querySelector('.chat__title')?.textContent?.trim()).toBe('named chat');
  });

  it('marks a queued follow-up with its own caption, and a steering line without one', () => {
    mocks.sessions.open = { version: 3, id: 'a', cwd: '/p/a', name: 'named chat', turns: [] };
    mocks.sessions.openRunning = true;
    mocks.sessions.pending = [
      { id: 'p1', text: 'use ripgrep', kind: 'steer', afterUserTurns: 0 },
      { id: 'p2', text: 'then the tests', kind: 'follow-up', afterUserTurns: 1 },
    ];

    const el = mount(ChatScreen);

    const captions = el.querySelectorAll('[data-testid="chat-queued"]');
    // Only the follow-up says it is waiting: a steering line is on its way in.
    expect(captions).toHaveLength(1);
    expect(captions[0]?.textContent?.trim()).toBe('已排队，这轮全部做完后发送');
    expect(el.querySelectorAll('.chat__pending')).toHaveLength(2);
  });
});
