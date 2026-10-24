// @vitest-environment jsdom
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

function mount(): HTMLButtonElement {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(SessionList);
  app.mount(root);
  return root.querySelector('button[aria-label="新建会话"]') as HTMLButtonElement;
}

describe('session list new chat', () => {
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

  it('disables the new-chat button without a selected project', () => {
    const button = mount();

    expect(button.disabled).toBe(true);
    button.click();
    expect(mocks.sessions.newConversation).not.toHaveBeenCalled();
  });

  it('enables the new-chat button for a project and opens a draft conversation', () => {
    const project = { path: '/p/a', name: 'a' };
    mocks.sessions.lastProject = project;
    mocks.selected = '/p/a';
    const button = mount();

    expect(button.disabled).toBe(false);
    button.click();
    expect(mocks.sessions.newConversation).toHaveBeenCalledWith(project);
  });
});
