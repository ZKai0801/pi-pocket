// @vitest-environment jsdom
import { createApp, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    pending: [] as Array<Record<string, unknown>>,
    modelNotes: [] as Array<Record<string, unknown>>,
    pendingDialog: null as Record<string, unknown> | null,
    dialogAnswering: false,
    answerPendingDialog: vi.fn(async () => {}),
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

vi.mock('../../src/stores/connections', () => ({
  useConnectionsStore: () => ({ activeName: null, hosts: [] }),
}));

vi.mock('@ui/components/AppIcon.vue', () => ({ default: { render: () => null } }));
vi.mock('../../src/components/sessions/ChatComposer.vue', () => ({ default: { render: () => null } }));

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

/** The transcript's bubbles, each as the plain text it shows. */
function bubbleTexts(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('.bubble__content')).map(
    (node) => node.textContent?.trim() ?? '',
  );
}

describe('chat segment bubbles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessions.open = null;
    mocks.sessions.openPath = '/r/a.jsonl';
    mocks.sessions.modelNotes = [];
    mocks.sessions.pending = [];
    mocks.sessions.lastProject = { path: '/p/a', name: 'a' };
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    root = null;
    document.body.innerHTML = '';
  });

  it('renders one bubble per segment of a run, not one for the whole run', () => {
    mocks.sessions.open = {
      version: 3,
      id: 'a',
      cwd: '/p/a',
      name: null,
      turns: [
        { role: 'user', text: 'check the build', timestampMs: 0 },
        {
          role: 'assistant',
          text: "I'll check.\nIt's busy.\nAll done.",
          timestampMs: 0,
          segments: ["I'll check.", "It's busy.", 'All done.'],
        },
      ],
      modelSwitches: [],
    };

    const el = mount();

    // The user's own line first, then one bubble per loop iteration.
    expect(bubbleTexts(el)).toEqual(['check the build', "I'll check.", "It's busy.", 'All done.']);
  });

  it('keeps one bubble for a turn without segments — a user line, or a cached parse', () => {
    mocks.sessions.open = {
      version: 3,
      id: 'a',
      cwd: '/p/a',
      name: null,
      turns: [
        { role: 'user', text: 'hello', timestampMs: 0 },
        { role: 'assistant', text: 'one reply only', timestampMs: 0 },
      ],
      modelSwitches: [],
    };

    const el = mount();

    expect(bubbleTexts(el)).toEqual(['hello', 'one reply only']);
  });
});
