// @vitest-environment jsdom
// tests/unit/sessionListRecent.test.ts
/**
 * The 会话 tab's first screen (spec §8.5): with no project selected the tab
 * paints the conversations recently opened on this host instead of the hint,
 * and a tap opens one directly — the whole point is not detouring through the
 * 项目 tab first. A project's selection still owns the list, and a phone with
 * no recents keeps the hint.
 */
import { createApp, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: {
    lastProject: null as { path: string; name: string } | null,
    sessions: [] as Array<Record<string, unknown>>,
    recents: [] as Array<Record<string, unknown>>,
    state: 'ready' as string,
    error: null as string | null,
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
    newConversation: vi.fn(),
    load: vi.fn(async () => {}),
    loadRecents: vi.fn(async () => {}),
    openSession: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
  },
  selected: null as string | null,
}));

vi.mock('../../src/stores/sessions', () => ({
  useSessionsStore: () => mocks.sessions,
  projectBasename: (path: string) => path.slice(path.lastIndexOf('/') + 1),
  relativeTime: () => '刚刚',
}));

vi.mock('../../src/stores/projects', () => ({
  useProjectsStore: () => ({ selected: mocks.selected }),
}));

vi.mock('@ui/components/AppIcon.vue', () => ({ default: { render: () => null } }));

import SessionList from '../../src/components/sessions/SessionList.vue';

let app: App | null = null;
let root: HTMLElement | null = null;

function mount(): HTMLElement {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(SessionList);
  app.mount(root);
  return root;
}

function recent(id: string, openedAtMs = 1): Record<string, unknown> {
  return {
    path: `/root/${id}.jsonl`,
    id,
    name: `session ${id}`,
    projectPath: '/p/a',
    updatedAtMs: 1,
    preview: `preview ${id}`,
    turnCount: 1,
    openedAtMs,
  };
}

describe('session list recent conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions.lastProject = null;
    mocks.sessions.sessions = [];
    mocks.sessions.recents = [];
    mocks.sessions.running = [];
    mocks.sessions.state = 'ready';
    mocks.sessions.error = null;
    mocks.selected = null;
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    root = null;
    document.body.innerHTML = '';
  });

  it('shows the recently opened conversations when no project is selected', () => {
    mocks.sessions.recents = [recent('a', 2), recent('b', 1)];
    const el = mount();

    expect(el.querySelector('[data-testid="sessions-recent"]')?.textContent?.trim())
      .toBe('最近打开');
    const rows = el.querySelectorAll('.sessions__item');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('session a');
    // …and the rows were read from the store on mount.
    expect(mocks.sessions.loadRecents).toHaveBeenCalledTimes(1);
  });

  it('opens a remembered conversation directly, without a project selection', () => {
    mocks.sessions.recents = [recent('a')];
    const el = mount();

    (el.querySelector('.sessions__item') as HTMLButtonElement).click();
    expect(mocks.sessions.openSession).toHaveBeenCalledWith('/root/a.jsonl');
  });

  it('marks a remembered conversation whose turn is still running', () => {
    mocks.sessions.recents = [recent('a'), recent('b')];
    mocks.sessions.running = ['/root/b.jsonl'];
    const el = mount();

    const pulses = el.querySelectorAll('[data-testid="session-running"]');
    expect(pulses).toHaveLength(1);
    expect(pulses[0]?.getAttribute('data-running')).toBe('/root/b.jsonl');
  });

  it('keeps the hint when nothing has been opened yet', () => {
    const el = mount();
    expect(el.querySelector('.sessions__status')?.textContent?.trim())
      .toBe('先选择一个项目');
    expect(el.querySelector('[data-testid="sessions-recent"]')).toBeNull();
  });

  it('shows the selected project\'s list instead of the recents', () => {
    mocks.selected = '/p/a';
    mocks.sessions.lastProject = { path: '/p/a', name: 'a' };
    mocks.sessions.sessions = [
      { path: '/root/x.jsonl', id: 'x', name: null, updatedAtMs: 1, preview: 'hi', turnCount: 1 },
    ];
    mocks.sessions.recents = [recent('a')];
    const el = mount();

    expect(el.querySelector('[data-testid="sessions-recent"]')).toBeNull();
    const rows = el.querySelectorAll('.sessions__item');
    expect(rows).toHaveLength(1);
    // A row with no name falls back to its id, exactly as before.
    expect(rows[0]?.textContent).toContain('x');
  });
});
