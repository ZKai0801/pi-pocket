// @vitest-environment jsdom
// tests/unit/sessionListDelete.test.ts
/**
 * The 会话 tab's delete journey, driven through the real store against a fake
 * host: a long-press turns the list into a tick list, taps tick rows, 删除 asks
 * before anything happens, and only the confirmation removes the files.
 *
 * Only the SSH seam is faked — the store, the rows and the dialog are the real
 * ones, so the load-bearing assertion is the screen the user sees and the
 * removals the host actually received, not a mock call. Each test mounts a
 * fresh store, so no test inherits another's in-flight read.
 */
import { createApp, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  removed: [] as string[],
  forgotten: [] as string[],
  fail: null as string | null,
  selected: '/p/a' as string | null,
  /** The store the mounted list and the test both share; rebuilt per mount. */
  store: null as Record<string, any> | null,
}));

vi.mock('../../src/stores/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/stores/sessions')>();
  return {
    ...actual,
    useSessionsStore: () => {
      if (env.store === null) {
        env.store = actual.createSessionsStore({
          listSessions: vi.fn(async () => env.rows),
          readSession: vi.fn(async () => ({
          version: 3,
          id: 'a',
          cwd: '/p/a',
          name: null,
          turns: [{ role: 'user', text: 'hi', timestampMs: 1 }],
        })),
        deleteSession: vi.fn(async (path: string) => {
          if (env.fail === path) throw new Error('read-only file system');
          env.removed.push(path);
        }),
        forgetSession: vi.fn(async (_host: string | null, path: string) => {
          env.forgotten.push(path);
        }),
        hostId: () => 'hetzner',
      } as never) as Record<string, any>;
      }
      return env.store;
    },
  };
});

vi.mock('../../src/stores/projects', () => ({
  useProjectsStore: () => ({ selected: env.selected }),
}));

vi.mock('@ui/components/AppIcon.vue', () => ({ default: { render: () => null } }));

import SessionList from '../../src/components/sessions/SessionList.vue';

let app: App | null = null;
let root: HTMLElement | null = null;

/** Let the store's listing, and every follow-on write, settle. */
async function flush(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

/** Mount the list and let it paint the project's conversations. */
async function mount(): Promise<HTMLElement> {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(SessionList);
  app.mount(root);
  await flush();
  return root;
}

/** The store the mounted list is using. */
function store(): Record<string, any> {
  if (env.store === null) throw new Error('the list has not been mounted yet');
  return env.store;
}

function row(path: string, name: string): Record<string, unknown> {
  return {
    path,
    id: path,
    name,
    updatedAtMs: 1,
    preview: `preview ${name}`,
    turnCount: 1,
    projectPath: '/p/a',
  };
}

function item(el: HTMLElement, path: string): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>(`[data-testid="session-item-${path}"]`);
  if (found === null) throw new Error(`no row for ${path}`);
  return found;
}

/** A press that is held: pointerdown, the hold elapsing, then release. */
async function longPress(el: HTMLElement, path: string): Promise<void> {
  const button = item(el, path);
  button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 10, clientY: 10 }));
  vi.advanceTimersByTime(600);
  button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 10, clientY: 10 }));
  button.click();
  await flush();
}

async function tap(el: HTMLElement, path: string): Promise<void> {
  item(el, path).click();
  await flush();
}

function control(el: HTMLElement, testId: string): HTMLButtonElement {
  const found = el.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (found === null) throw new Error(`no control ${testId}`);
  return found;
}

function titles(el: HTMLElement): string[] {
  return [...el.querySelectorAll('.sessions__name')].map((node) => node.textContent?.trim() ?? '');
}

const A = '/root/a.jsonl';
const B = '/root/b.jsonl';
const C = '/root/c.jsonl';

describe('session list multi-select delete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // A fresh store per test: the next mount builds it.
    env.store = null;
    env.rows = [row(A, 'first'), row(B, 'second'), row(C, 'third')];
    env.removed = [];
    env.forgotten = [];
    env.fail = null;
    env.selected = '/p/a';
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    root = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('a plain list shows the long-press hint and no delete action', async () => {
    const el = await mount();

    expect(el.querySelector('.sessions__hint')?.textContent?.trim()).toBe('长按会话即可多选');
    expect(el.querySelector('[data-testid="sessions-delete"]')).toBeNull();
    expect(store().selecting).toBe(false);
    expect(titles(el)).toEqual(['first', 'second', 'third']);
  });

  it('a long-press paints the tick boxes and does not open the conversation', async () => {
    const el = await mount();
    await longPress(el, B);

    // The press armed the mode: tick boxes replace the chevrons.
    expect(el.querySelectorAll('[data-testid="session-check"]')).toHaveLength(3);
    expect(el.querySelectorAll('.sessions__chevron')).toHaveLength(0);
    // The hint has served its purpose.
    expect(el.querySelector('.sessions__hint')).toBeNull();
    // …and the row long-pressed is the one that got ticked.
    expect(item(el, B).getAttribute('aria-pressed')).toBe('true');
    expect(item(el, A).getAttribute('aria-pressed')).toBe('false');
  });

  it('a short press opens the conversation and never arms the tick list', async () => {
    const el = await mount();
    const button = item(el, A);
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(120);
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 10, clientY: 10 }));
    button.click();
    await flush();

    expect(store().openPath).toBe(A);
  });

  it('a press that travels is a scroll: no tick list, no open', async () => {
    const el = await mount();
    const button = item(el, A);
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 10, clientY: 10 }));
    button.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, isPrimary: true, clientX: 10, clientY: 60 }));
    vi.advanceTimersByTime(600);
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 10, clientY: 60 }));
    button.click();
    await flush();

    // The hold never armed, so the list is still a plain list.
    expect(store().selecting).toBe(false);
    expect(el.querySelectorAll('[data-testid="session-check"]')).toHaveLength(0);
  });

  it('the whole journey: long-press, tick a second row, confirm, and they are gone', async () => {
    const el = await mount();

    // 1. Long-press the first row: the list becomes a tick list.
    await longPress(el, A);
    expect(control(el, 'sessions-select-title').textContent?.trim()).toBe('已选 1 个');
    expect(item(el, A).getAttribute('aria-pressed')).toBe('true');

    // 2. Tap a second row: it ticks instead of opening.
    await tap(el, C);
    expect(control(el, 'sessions-select-title').textContent?.trim()).toBe('已选 2 个');
    expect(item(el, C).getAttribute('aria-pressed')).toBe('true');

    // 3. 删除 asks first — nothing has been removed yet.
    control(el, 'sessions-delete').click();
    await flush();
    expect(control(el, 'sessions-delete-confirm').textContent).toContain('删除选中的 2 个会话？');
    expect(env.removed).toEqual([]);

    // 4. Confirming removes exactly those two files …
    control(el, 'sessions-delete-confirm-ok').click();
    await flush();
    expect(env.removed).toEqual([A, C]);

    // … and only the unticked conversation is left on screen.
    expect(titles(el)).toEqual(['second']);

    // The dialog closed, and the list is out of the tick list.
    expect(el.querySelector('[data-testid="sessions-delete-confirm"]')).toBeNull();
    expect(el.querySelector('[data-testid="sessions-select-title"]')).toBeNull();
    // Their backups went with them.
    expect(env.forgotten).toEqual([A, C]);
  });

  it('a cancelled confirmation leaves every conversation on the host', async () => {
    const el = await mount();
    await longPress(el, A);
    control(el, 'sessions-delete').click();
    await flush();
    control(el, 'sessions-delete-cancel').click();
    await flush();

    expect(env.removed).toEqual([]);
    expect(titles(el)).toEqual(['first', 'second', 'third']);
  });

  it('完成 leaves the tick list without removing anything', async () => {
    const el = await mount();
    await longPress(el, A);
    control(el, 'sessions-select-done').click();
    await flush();

    expect(env.removed).toEqual([]);
    expect(el.querySelectorAll('[data-testid="session-check"]')).toHaveLength(0);
  });

  it('删除 stays disabled until something is ticked', async () => {
    const el = await mount();
    await longPress(el, A);
    // Untick the row the long-press ticked.
    await tap(el, A);

    expect((control(el, 'sessions-delete') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a running conversation is named in the dialog but cannot be ticked', async () => {
    const el = await mount();
    store().running = [B];
    await flush();
    await longPress(el, A);

    const boxes = el.querySelectorAll('[data-testid="session-check"]');
    expect(boxes[1]?.getAttribute('data-blocked')).toBe('true');

    // A tap reports the tick; the store refuses it for a running conversation.
    await tap(el, B);
    expect(item(el, B).getAttribute('aria-pressed')).toBe('false');
    expect(store().selected).toEqual([A]);
  });

  it('a failed removal keeps the conversation on screen and says why', async () => {
    env.fail = A;
    const el = await mount();
    await longPress(el, A);
    control(el, 'sessions-delete').click();
    await flush();
    control(el, 'sessions-delete-confirm-ok').click();
    await flush();

    // Nothing was removed, so the row is still there and still ticked …
    expect(env.removed).toEqual([]);
    expect(titles(el)).toEqual(['first', 'second', 'third']);
    expect(item(el, A).getAttribute('aria-pressed')).toBe('true');
    // … and the dialog stays up with the reason written into it.
    const dialog = el.querySelector('[data-testid="sessions-delete-confirm"]');
    expect(dialog?.querySelector('.sessions__confirm-error')?.textContent?.trim())
      .toBe('删除失败：read-only file system');
  });
});
