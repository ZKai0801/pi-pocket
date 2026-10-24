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
// The composer owns its own tests; here it only has to stay out of the way.
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

/** The transcript's children, each reduced to what kind of row it is. */
function rowKinds(el: HTMLElement): string[] {
  const turns = el.querySelector('.chat__turns');
  if (turns === null) throw new Error('no transcript');
  return Array.from(turns.children).map((child) => {
    if (child.classList.contains('chat__time')) return 'time';
    if (child.classList.contains('chat__model')) return `model:${child.textContent?.trim() ?? ''}`;
    if (child.classList.contains('chat__pending')) return 'pending';
    return 'bubble';
  });
}

function dividers(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('[data-testid="chat-model-switch"]')).map(
    (node) => node.textContent?.trim() ?? '',
  );
}

function modelName(el: HTMLElement): string | null {
  const node = el.querySelector('[data-testid="chat-model-name"]');
  return node === null ? null : node.textContent?.trim() ?? null;
}

describe('chat model-switch divider', () => {
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

  it('renders the divider after the turns the switch was appended behind', () => {
    mocks.sessions.open = {
      version: 3,
      id: 'a',
      cwd: '/p/a',
      name: null,
      turns: [
        { role: 'user', text: 'one', timestampMs: 0 },
        { role: 'assistant', text: 'done', timestampMs: 0 },
      ],
      modelSwitches: [
        {
          to: 'openai/gpt-5.1-codex',
          from: 'anthropic/claude-sonnet-4-5',
          timestampMs: 0,
          afterTurns: 2,
        },
      ],
    };

    const el = mount();

    expect(rowKinds(el)).toEqual(['bubble', 'bubble', 'model:--- 模型已切换为 openai/gpt-5.1-codex ---']);
  });

  it('draws no divider for the switch a session opened with — the header names it instead', () => {
    mocks.sessions.open = {
      version: 3,
      id: 'a',
      cwd: '/p/a',
      name: null,
      turns: [{ role: 'user', text: 'one', timestampMs: 0 }],
      model: 'openai/gpt-5.1-codex',
      modelSwitches: [
        { to: 'openai/gpt-5.1-codex', from: null, timestampMs: 0, afterTurns: 0 },
      ],
    };

    const el = mount();

    // The session began on this model: a "switched to" line would claim a
    // change that never happened, and the header already says which model
    // is in effect.
    expect(rowKinds(el)).toEqual(['bubble']);
    expect(modelName(el)).toBe('openai/gpt-5.1-codex');
  });

  it('keeps two switches in file order, each at its own position', () => {
    mocks.sessions.open = {
      version: 3,
      id: 'a',
      cwd: '/p/a',
      name: null,
      turns: [
        { role: 'user', text: 'one', timestampMs: 0 },
        { role: 'assistant', text: 'first', timestampMs: 0 },
        { role: 'user', text: 'two', timestampMs: 0 },
        { role: 'assistant', text: 'second', timestampMs: 0 },
      ],
      modelSwitches: [
        { to: 'openai/gpt-5.1-codex', from: 'anthropic/claude-sonnet-4-5', timestampMs: 0, afterTurns: 2 },
        { to: 'google/gemini-3-pro', from: 'openai/gpt-5.1-codex', timestampMs: 0, afterTurns: 4 },
      ],
    };

    const el = mount();

    expect(rowKinds(el)).toEqual([
      'bubble',
      'bubble',
      'model:--- 模型已切换为 openai/gpt-5.1-codex ---',
      'bubble',
      'bubble',
      'model:--- 模型已切换为 google/gemini-3-pro ---',
    ]);
  });

  it('names the model now in effect even when the file cannot say what it replaced', () => {
    mocks.sessions.open = {
      version: 3,
      id: 'a',
      cwd: '/p/a',
      name: null,
      turns: [{ role: 'user', text: 'one', timestampMs: 0 }],
      modelSwitches: [
        { to: 'openai/gpt-5.1-codex', from: null, timestampMs: 0, afterTurns: 1 },
      ],
    };

    const el = mount();

    expect(dividers(el)).toEqual(['--- 模型已切换为 openai/gpt-5.1-codex ---']);
  });

  it('reads a session that records no switches as a transcript with no divider', () => {
    mocks.sessions.open = {
      version: 3,
      id: 'a',
      cwd: '/p/a',
      name: null,
      turns: [
        { role: 'user', text: 'one', timestampMs: 0 },
        { role: 'assistant', text: 'done', timestampMs: 0 },
      ],
    };

    const el = mount();

    expect(dividers(el)).toEqual([]);
    expect(rowKinds(el)).toEqual(['bubble', 'bubble']);
  });

  it('shows a switch the file has not recorded yet as a note after the turns', () => {
    mocks.sessions.open = {
      version: 3,
      id: 'a',
      cwd: '/p/a',
      name: null,
      turns: [
        { role: 'user', text: 'one', timestampMs: 0 },
        { role: 'assistant', text: 'done', timestampMs: 0 },
      ],
    };
    mocks.sessions.modelNotes = [{ id: 'model-note-7', to: 'openai/gpt-5.1-codex', baseline: 0 }];

    const el = mount();

    // The command was accepted moments ago and pi appends its entry after the
    // write: the note is on screen with no read in between, and it is what
    // the header names until the file speaks.
    expect(rowKinds(el)).toEqual(['bubble', 'bubble', 'model:--- 模型已切换为 openai/gpt-5.1-codex ---']);
    expect(modelName(el)).toBe('openai/gpt-5.1-codex');
  });

  it('names the file\'s own model under the title', () => {
    mocks.sessions.open = {
      version: 3,
      id: 'a',
      cwd: '/p/a',
      name: 'named chat',
      model: 'anthropic/claude-sonnet-4-5',
      turns: [{ role: 'user', text: 'one', timestampMs: 0 }],
    };

    const el = mount();

    expect(modelName(el)).toBe('anthropic/claude-sonnet-4-5');
    // The name itself is untouched by the small line under it.
    expect(el.querySelector('.chat__title')?.textContent?.trim()).toBe('named chat');
  });

  it('leaves the header\'s model line out when nothing says which model is in effect', () => {
    mocks.sessions.open = {
      version: 3,
      id: 'a',
      cwd: '/p/a',
      name: null,
      turns: [{ role: 'user', text: 'one', timestampMs: 0 }],
    };

    const el = mount();

    expect(modelName(el)).toBeNull();
  });

  it('sits between the time separators a switch falls between', () => {
    mocks.sessions.open = {
      version: 3,
      id: 'a',
      cwd: '/p/a',
      name: null,
      turns: [
        { role: 'user', text: 'one', timestampMs: Date.parse('2026-10-20T02:00:00.000Z') },
        { role: 'assistant', text: 'first', timestampMs: Date.parse('2026-10-20T02:01:00.000Z') },
        { role: 'user', text: 'two', timestampMs: Date.parse('2026-10-20T03:00:00.000Z') },
      ],
      modelSwitches: [
        {
          to: 'openai/gpt-5.1-codex',
          from: 'anthropic/claude-sonnet-4-5',
          timestampMs: 0,
          afterTurns: 2,
        },
      ],
    };

    const el = mount();

    // The gap after the second turn earns a separator; the divider sits
    // between the conversation it closed and the one that followed.
    expect(rowKinds(el)).toEqual([
      'time',
      'bubble',
      'bubble',
      'model:--- 模型已切换为 openai/gpt-5.1-codex ---',
      'time',
      'bubble',
    ]);
  });
});
