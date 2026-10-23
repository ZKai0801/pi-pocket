import { describe, expect, it, vi } from 'vitest';
import type {
  PiCommandRunResult,
  PiTurnBegun,
  PiTurnRunner,
  PiTurnSendResult,
} from '../../src/pi/piTurnRunner';
import type { ParsedPiSession } from '../../src/pi/types';
import {
  createSessionsStore,
  createTurnRunnerFacade,
  localiseTurnError,
} from '../../src/stores/sessions';

const session: ParsedPiSession = {
  version: 3,
  id: 'a',
  cwd: '/home/kai',
  name: null,
  turns: [{ role: 'user', text: 'hi', timestampMs: 1 }],
};

const replied: ParsedPiSession = {
  ...session,
  turns: [...session.turns, { role: 'assistant', text: 'ok', timestampMs: 2 }],
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The reply has not landed yet, and nothing says when it will. */
async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function begun(sessionFile: string, completed: Promise<PiTurnSendResult>): PiTurnBegun {
  return { ok: true, sessionFile, completed };
}

function runnerWith(
  overrides: Partial<PiTurnRunner> & { busy?: boolean } = {},
): PiTurnRunner {
  const { busy = false, ...rest } = overrides;
  return {
    send: vi.fn(async () => ({ ok: true as const, session })),
    startNew: vi.fn(async () => ({
      ok: true as const,
      sessionFile: '/r/new.jsonl',
      session,
    })),
    beginSend: vi.fn(async (path: string) => begun(path, Promise.resolve({ ok: true as const, session }))),
    beginStartNew: vi.fn(async () => begun('/r/new.jsonl', Promise.resolve({ ok: true as const, session }))),
    runCommand: vi.fn(async () => ({ ok: true as const, hiddenUi: false })),
    queue: vi.fn(async () => ({ ok: true as const })),
    rebind: vi.fn(),
    isBusy: vi.fn(() => busy),
    dispose: vi.fn(),
    ...rest,
  };
}

function storeWith(runner: unknown, hostId?: () => string | null) {
  return createSessionsStore({
    listSessions: vi.fn(async () => []),
    readSession: vi.fn(async () => session),
    runner,
    hostId,
  } as never);
}

describe('sessions store send', () => {
  it('reports sent once the line is delivered, with the user turn on screen and the chat running', async () => {
    const reply = deferred<PiTurnSendResult>();
    const runner = runnerWith({ beginSend: vi.fn(async (path: string) => begun(path, reply.promise)) });
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    await expect(store.send('next please')).resolves.toBe('sent');

    // Delivered, not answered: the message is visible and the turn is running.
    expect(runner.beginSend).toHaveBeenCalledWith('/r/a.jsonl', 'next please');
    expect(store.open?.turns).toHaveLength(2);
    expect(store.open?.turns[1]).toMatchObject({ role: 'user', text: 'next please' });
    expect(store.running).toEqual(['/r/a.jsonl']);
    expect(store.openRunning).toBe(true);
    expect(store.sending).toBe(false);
    expect(store.sendError).toBeNull();

    reply.resolve({ ok: true, session: replied });
    await flush();

    expect(store.open).toEqual(replied);
    expect(store.running).toEqual([]);
    expect(store.openRunning).toBe(false);
  });

  it('keeps sending true only while the line is being written', async () => {
    const turn = deferred<PiTurnBegun>();
    const runner = runnerWith({ beginSend: vi.fn(() => turn.promise) });
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    const pending = store.send('hi');
    expect(store.sending).toBe(true);

    turn.resolve(begun('/r/a.jsonl', deferred<PiTurnSendResult>().promise));
    await expect(pending).resolves.toBe('sent');
    expect(store.sending).toBe(false);
  });

  it('steers the turn that is already running instead of refusing the message', async () => {
    const reply = deferred<PiTurnSendResult>();
    const runner = runnerWith({ beginSend: vi.fn(async (path: string) => begun(path, reply.promise)) });
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');
    await store.send('one');

    await expect(store.send('use ripgrep instead')).resolves.toBe('sent');

    // No second turn and no second PTY: the line joins the run in flight.
    expect(runner.beginSend).toHaveBeenCalledTimes(1);
    expect(runner.queue).toHaveBeenCalledWith('/r/a.jsonl', 'use ripgrep instead', 'steer');
    // The chat still says running, and the line is a ghost until Pi writes it.
    expect(store.running).toEqual(['/r/a.jsonl']);
    expect(store.pending).toEqual([
      { id: expect.any(String), text: 'use ripgrep instead', kind: 'steer', afterUserTurns: 2 },
    ]);
    expect(store.sending).toBe(false);
    expect(store.sendError).toBeNull();
  });

  it('queues a follow-up behind the running turn', async () => {
    const reply = deferred<PiTurnSendResult>();
    const runner = runnerWith({ beginSend: vi.fn(async (path: string) => begun(path, reply.promise)) });
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');
    await store.send('one');

    await expect(store.send('then run the tests', 'follow-up')).resolves.toBe('sent');

    expect(runner.queue).toHaveBeenCalledWith('/r/a.jsonl', 'then run the tests', 'follow-up');
    expect(store.pending[0]).toMatchObject({ kind: 'follow-up' });
    expect(store.running).toEqual(['/r/a.jsonl']);
  });

  it('drops the ghost once the session file has the queued line', async () => {
    const reply = deferred<PiTurnSendResult>();
    const runner = runnerWith({ beginSend: vi.fn(async (path: string) => begun(path, reply.promise)) });
    let read: ParsedPiSession = session;
    const store = createSessionsStore({
      listSessions: vi.fn(async () => []),
      readSession: vi.fn(async () => read),
      runner,
    } as never);
    await store.openSession('/r/a.jsonl');
    await store.send('one');
    await store.send('two', 'follow-up');
    expect(store.pending).toHaveLength(1);

    // The file now holds both delivered lines and the steered one: the ghost
    // has served its purpose.
    read = {
      ...session,
      turns: [
        ...session.turns,
        { role: 'user', text: 'one', timestampMs: 2 },
        { role: 'user', text: 'two', timestampMs: 3 },
      ],
    };
    await store.refresh();
    expect(store.pending).toEqual([]);
  });

  it('reports a queue failure when the run ended under the tap', async () => {
    const reply = deferred<PiTurnSendResult>();
    const runner = runnerWith({
      beginSend: vi.fn(async (path: string) => begun(path, reply.promise)),
      queue: vi.fn(async () => ({
        ok: false as const,
        error: 'There is no running turn to add a message to.',
      })),
    });
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');
    await store.send('one');

    await expect(store.send('too late')).resolves.toBe('error');

    expect(store.sendError).toBe('这一轮已经结束了，这条消息没有发出去。');
    expect(store.pending).toEqual([]);
    expect(store.sending).toBe(false);
  });

  it('runs two conversations at once and paints each reply into its own chat', async () => {
    const replyA = deferred<PiTurnSendResult>();
    const replyB = deferred<PiTurnSendResult>();
    const beginSend = vi.fn(async (path: string, text: string) => {
      expect(text).toBeTruthy();
      return begun(path, path === '/r/a.jsonl' ? replyA.promise : replyB.promise);
    });
    const store = storeWith(runnerWith({ beginSend }));
    await store.openSession('/r/a.jsonl');
    await store.send('to a');

    await store.openSession('/r/a.jsonl');
    await store.openSession('/r/b.jsonl');
    await store.send('to b');

    expect(store.running).toEqual(['/r/a.jsonl', '/r/b.jsonl']);

    replyA.resolve({ ok: true, session: replied });
    await flush();

    // A finished in the background: its flag clears, and the open chat (B) is
    // never repainted with A's transcript.
    expect(store.running).toEqual(['/r/b.jsonl']);
    expect(store.open?.id).toBe('a');
    expect(store.open?.turns).toHaveLength(2);

    replyB.resolve({ ok: true, session: replied });
    await flush();
    expect(store.running).toEqual([]);
  });

  it('keeps a turn running after its chat closes and updates the list row when the reply lands', async () => {
    const reply = deferred<PiTurnSendResult>();
    const store = storeWith(runnerWith({ beginSend: vi.fn(async (path: string) => begun(path, reply.promise)) }));
    store.sessions = [
      { path: '/r/a.jsonl', id: 'a', name: null, updatedAtMs: 1, preview: 'old', turnCount: 1 },
      { path: '/r/other.jsonl', id: 'other', name: null, updatedAtMs: 5, preview: 'other', turnCount: 1 },
    ];
    await store.openSession('/r/a.jsonl');
    await store.send('hi');
    store.closeChat();

    // Leaving the chat does not stop the turn, and the row still says so.
    expect(store.openPath).toBeNull();
    expect(store.running).toEqual(['/r/a.jsonl']);

    reply.resolve({ ok: true, session: replied });
    await flush();

    expect(store.running).toEqual([]);
    expect(store.sessions.map((meta) => meta.path)).toEqual(['/r/a.jsonl', '/r/other.jsonl']);
    expect(store.sessions[0]).toMatchObject({ preview: 'ok', turnCount: 2 });
    expect(store.open).toBeNull();
  });

  it('reports a delivery failure and keeps the conversation clean', async () => {
    const runner = runnerWith({
      beginSend: vi.fn(async () => ({
        ok: false as const,
        error: 'The turn timed out before Pi wrote a new assistant reply.',
      })),
    });
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    await expect(store.send('hi')).resolves.toBe('error');
    expect(store.sendError).toBe('等待回复超时，请重试。');
    expect(store.running).toEqual([]);
    expect(store.open?.turns).toHaveLength(1);
    expect(store.sending).toBe(false);
  });

  it('reports the reply timeout of a delivered turn on the chat that owns it', async () => {
    const reply = deferred<PiTurnSendResult>();
    const store = storeWith(runnerWith({ beginSend: vi.fn(async (path: string) => begun(path, reply.promise)) }));
    await store.openSession('/r/a.jsonl');
    await store.send('hi');

    reply.resolve({ ok: false, error: 'The turn timed out before Pi wrote a new assistant reply.' });
    await flush();

    expect(store.running).toEqual([]);
    expect(store.sendError).toBe('等待回复超时，请重试。');
    // The user's line is still there: the turn was delivered, the reply is not.
    expect(store.open?.turns).toHaveLength(2);
  });

  it('refuses to send with no open session', async () => {
    const runner = runnerWith();
    const store = storeWith(runner);

    expect(await store.send('hi')).toBe('error');
    expect(runner.beginSend).not.toHaveBeenCalled();
    expect(store.sendError).not.toBeNull();
  });

  it('refuses empty or whitespace text without calling the runner', async () => {
    const runner = runnerWith();
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    expect(await store.send('   ')).toBe('error');
    expect(store.sendError).toBe('消息为空。');
    expect(runner.beginSend).not.toHaveBeenCalled();
  });

  it('drops a send that settles after the host changed', async () => {
    const reply = deferred<PiTurnSendResult>();
    const runner = runnerWith({ beginSend: vi.fn(async (path: string) => begun(path, reply.promise)) });
    let host = 'A';
    const store = storeWith(runner, () => host);
    await store.openSession('/r/a.jsonl');

    await store.send('hi');
    host = 'B';
    store.hostChanged();
    reply.resolve({ ok: true, session: replied });
    await flush();

    // The delivered line stays, the old host's reply never paints.
    expect(store.open?.turns).toHaveLength(2);
    expect(store.open?.turns[1]).toMatchObject({ role: 'user', text: 'hi' });
    expect(store.running).toEqual([]);
    expect(store.sendError).toBeNull();
    expect(store.sending).toBe(false);
  });

  it('drops a send when the host dep changes without a hostChanged signal', async () => {
    const reply = deferred<PiTurnSendResult>();
    const runner = runnerWith({ beginSend: vi.fn(async (path: string) => begun(path, reply.promise)) });
    let host = 'A';
    const store = storeWith(runner, () => host);
    await store.openSession('/r/a.jsonl');

    await store.send('hi');
    host = 'B';
    reply.resolve({ ok: true, session: replied });
    await flush();

    expect(store.open?.turns).toHaveLength(2);
    expect(store.open?.turns[1]?.role).toBe('user');
    expect(store.running).toEqual([]);
    expect(store.sendError).toBeNull();
  });

  it('reports an error when the runner rejects without throwing', async () => {
    const runner = runnerWith({
      beginSend: vi.fn(async () => {
        throw new Error('This turn runner has been disposed.');
      }),
    });
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    await expect(store.send('hi')).resolves.toBe('error');
    expect(store.sending).toBe(false);
    expect(store.sendError).toBe('当前会话已断开，请重新打开。');
  });

  it('refuses to send without a runner and never throws', async () => {
    const store = createSessionsStore({
      listSessions: vi.fn(async () => []),
      readSession: vi.fn(async () => session),
      hostId: () => 'A',
    } as never);
    await store.openSession('/r/a.jsonl');

    await expect(store.send('hi')).resolves.toBe('error');
    expect(store.sendError).toBe('当前无法发送消息。');
    expect(store.sending).toBe(false);
  });

  it('clears the last send error when the host changes', async () => {
    const runner = runnerWith({
      beginSend: vi.fn(async () => ({
        ok: false as const,
        error: 'The turn timed out before Pi wrote a new assistant reply.',
      })),
    });
    const store = storeWith(runner, () => 'A');
    await store.openSession('/r/a.jsonl');
    await store.send('hi');
    expect(store.sendError).toBe('等待回复超时，请重试。');

    store.hostChanged();
    expect(store.sendError).toBeNull();
  });

  it('clears the last send error when another project loads', async () => {
    const runner = runnerWith({
      beginSend: vi.fn(async () => ({
        ok: false as const,
        error: 'The turn timed out before Pi wrote a new assistant reply.',
      })),
    });
    const store = storeWith(runner, () => 'A');
    await store.openSession('/r/a.jsonl');
    await store.send('hi');
    expect(store.sendError).toBe('等待回复超时，请重试。');

    await store.load({ path: '/p/b', name: 'b' });
    expect(store.sendError).toBeNull();
  });

  it('newConversation opens an empty draft chat for the selected project', () => {
    const runner = runnerWith();
    const store = storeWith(runner);
    store.sendError = '旧错误';
    const project = { path: '/p/a', name: 'a' };

    store.newConversation(project);

    expect(store.lastProject).toEqual(project);
    expect(store.open).toEqual({ version: 3, id: '', cwd: '/p/a', name: null, turns: [] });
    expect(store.openPath).toBeNull();
    expect(store.startingNew).toBe(true);
    expect(store.sendError).toBeNull();

    store.closeChat();
    expect(store.startingNew).toBe(false);
  });

  it('clears a previous list error when a draft chat opens', () => {
    const runner = runnerWith();
    const store = storeWith(runner);
    const existing = [
      {
        path: '/r/old.jsonl',
        id: 'old',
        name: null,
        updatedAtMs: 5,
        preview: 'old',
        turnCount: 1,
      },
    ];
    store.state = 'error';
    store.error = '加载失败';
    store.sessions = existing;

    store.newConversation({ path: '/p/a', name: 'a' });

    expect(store.state).toBe('idle');
    expect(store.error).toBeNull();
    expect(store.sessions).toEqual(existing);
  });

  it('adopts a draft at delivery time and prepends its row, then fills the row in', async () => {
    const reply = deferred<PiTurnSendResult>();
    const adopted: PiTurnSendResult = { ok: true, session: { ...session, id: 'new', cwd: '/p/a', turns: replied.turns } };
    const runner = runnerWith({
      beginStartNew: vi.fn(async () => begun('/r/new.jsonl', reply.promise)),
    });
    const store = storeWith(runner);
    store.sessions = [
      { path: '/r/other.jsonl', id: 'other', name: null, updatedAtMs: 5, preview: 'old', turnCount: 1 },
    ];
    store.newConversation({ path: '/p/a', name: 'a' });

    await expect(store.send('first message')).resolves.toBe('sent');

    // The draft names its file as soon as Pi writes it, before the reply.
    expect(runner.beginStartNew).toHaveBeenCalledWith('/p/a', 'first message');
    expect(store.openPath).toBe('/r/new.jsonl');
    expect(store.startingNew).toBe(false);
    expect(store.sessions.map((meta) => meta.path)).toEqual(['/r/new.jsonl', '/r/other.jsonl']);
    expect(store.sessions[0]).toMatchObject({ id: 'new', preview: 'first message', turnCount: 1 });
    expect(store.running).toEqual(['/r/new.jsonl']);

    reply.resolve(adopted);
    await flush();

    expect(store.open).toEqual(adopted.session);
    expect(store.sessions[0]).toMatchObject({ id: 'new', preview: 'ok', turnCount: 2 });
    expect(store.sessions.filter((meta) => meta.path === '/r/new.jsonl')).toHaveLength(1);
    expect(store.running).toEqual([]);
  });

  it('keeps the adopted row after the draft chat closes', async () => {
    const runner = runnerWith({
      beginStartNew: vi.fn(async () => begun('/r/new.jsonl', Promise.resolve({ ok: true as const, session: replied }))),
    });
    const store = storeWith(runner);
    store.newConversation({ path: '/p/a', name: 'a' });
    await store.send('hi');
    await flush();

    store.closeChat();
    expect(store.sessions[0]?.path).toBe('/r/new.jsonl');
    expect(store.running).toEqual([]);
  });

  it('does not prepend adopted metadata to another project\'s list', async () => {
    const reply = deferred<PiTurnSendResult>();
    const runner = runnerWith({ beginStartNew: vi.fn(async () => begun('/r/new.jsonl', reply.promise)) });
    const store = storeWith(runner);
    const otherProjectList = [
      {
        path: '/r/other-project.jsonl',
        id: 'other-project',
        name: null,
        updatedAtMs: 5,
        preview: 'other',
        turnCount: 1,
      },
    ];
    store.newConversation({ path: '/p/a', name: 'a' });
    store.lastProject = { path: '/p/b', name: 'b' };
    store.sessions = otherProjectList;

    await expect(store.send('hi')).resolves.toBe('sent');
    expect(store.openPath).toBe('/r/new.jsonl');
    expect(store.sessions).toEqual(otherProjectList);

    reply.resolve({ ok: true, session: replied });
    await flush();
    expect(store.sessions).toEqual(otherProjectList);
  });

  it('keeps the draft chat when the first turn is never delivered', async () => {
    const runner = runnerWith({
      beginStartNew: vi.fn(async () => ({
        ok: false as const,
        error: 'No new session file appeared before the timeout.',
      })),
    });
    const store = storeWith(runner);
    store.newConversation({ path: '/p/a', name: 'a' });

    expect(await store.send('hi')).toBe('error');

    expect(store.open).toEqual({ version: 3, id: '', cwd: '/p/a', name: null, turns: [] });
    expect(store.openPath).toBeNull();
    expect(store.startingNew).toBe(true);
    expect(store.sending).toBe(false);
    expect(store.running).toEqual([]);
    expect(store.sendError).toBe('新会话创建超时，请重试。');
  });

  it('drops a draft turn whose project changed before delivery', async () => {
    const turn = deferred<PiTurnBegun>();
    const reply = deferred<PiTurnSendResult>();
    const runner = runnerWith({ beginStartNew: vi.fn(() => turn.promise) });
    const store = storeWith(runner, () => 'A');
    store.newConversation({ path: '/p/a', name: 'a' });

    const pending = store.send('hi');
    const switched = { version: 3, id: '', cwd: '/p/b', name: null, turns: [] };
    store.open = switched;
    turn.resolve(begun('/r/new.jsonl', reply.promise));

    expect(await pending).toBe('sent');
    // The message did reach Pi — so it is tracked as running — but the
    // abandoned draft never paints it.
    expect(store.open).toEqual(switched);
    expect(store.openPath).toBeNull();
    expect(store.startingNew).toBe(true);
    expect(store.sendError).toBeNull();
    expect(store.sending).toBe(false);
    expect(store.running).toEqual(['/r/new.jsonl']);

    reply.resolve({ ok: true, session: replied });
    await flush();
    expect(store.running).toEqual([]);
  });

  it('routes the turn after adoption to the adopted path through the real facade', async () => {
    const adopted: PiTurnSendResult = {
      ok: true,
      session: {
        ...session,
        id: 'new',
        cwd: '/p/a',
        turns: [
          { role: 'user' as const, text: 'hi', timestampMs: 1 },
          { role: 'assistant' as const, text: 'ok', timestampMs: 2 },
        ],
      },
    };
    const draft = runnerWith({
      beginStartNew: vi.fn(async () => begun('/r/new.jsonl', Promise.resolve(adopted))),
    });
    const normal = runnerWith({
      beginSend: vi.fn(async (path: string) => begun(path, Promise.resolve(adopted))),
    });
    const runnerFor = vi.fn(async (sessionFile: string) =>
      sessionFile === '' ? draft : normal,
    );
    const release = vi.fn();
    let store!: ReturnType<typeof createSessionsStore>;
    const facade = createTurnRunnerFacade({
      runnerFor,
      release,
      rebind: vi.fn(),
      dispose: vi.fn(),
      openPath: () => store.openPath,
      startingNew: () => store.startingNew,
    });
    store = createSessionsStore({
      listSessions: vi.fn(async () => []),
      readSession: vi.fn(async () => session),
      runner: facade,
      hostId: () => 'A',
    });
    store.newConversation({ path: '/p/a', name: 'a' });

    expect(await store.send('hi')).toBe('sent');
    await flush();
    expect(await store.send('next')).toBe('sent');
    await flush();

    expect(runnerFor.mock.calls.map(([sessionFile]) => sessionFile)).toEqual([
      '',
      '/r/new.jsonl',
    ]);
    // The sessionless draft runner is given back once its turn settles.
    expect(release).toHaveBeenCalledWith('');
    expect(normal.beginSend).toHaveBeenCalledWith('/r/new.jsonl', 'next');
  });

  it('maps every runner failure string to its own copy', () => {
    const cases: Array<[string, string]> = [
      ['A turn is already running in this chat.', '上一条消息仍在处理中，请稍候。'],
      ['This turn runner has been disposed.', '当前会话已断开，请重新打开。'],
      ['This runner is already attached to a session.', '该会话已打开，无法新建会话。'],
      ['The message was not sent (unknown).', '消息未发送成功，请重试。'],
      ['The message is empty.', '消息为空。'],
      ['Pi did not become ready before the timeout.', 'Pi 尚未准备好，请稍后重试。'],
      ['No new session file appeared before the timeout.', '新会话创建超时，请重试。'],
      ['The turn timed out before Pi wrote a new assistant reply.', '等待回复超时，请重试。'],
      ['The terminal did not confirm this input.', '消息写入失败，请重试。'],
      ['The chat changed before the turn could start.', '会话已切换，请重新发送。'],
    ];
    for (const [raw, copy] of cases) {
      expect(localiseTurnError(raw)).toBe(copy);
    }
    // The readiness failure carries the word "timeout"; it must never fall
    // through to the generic timeout copy.
    expect(localiseTurnError('Pi did not become ready before the timeout.')).not.toBe(
      '等待回复超时，请重试。',
    );
  });

  it('routes a slash command to the command channel instead of a turn', async () => {
    const runner = runnerWith({
      runCommand: vi.fn(async () => ({ ok: true as const, hiddenUi: false })),
    });
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    expect(await store.send('/compact keep the API notes')).toBe('sent');

    expect(runner.runCommand).toHaveBeenCalledWith('/r/a.jsonl', '/compact keep the API notes');
    expect(runner.beginSend).not.toHaveBeenCalled();
    // A command appends nothing to the session, so the transcript stands.
    expect(store.open).toEqual(session);
    expect(store.sendError).toBeNull();
    expect(store.sendNotice).toBeNull();
    expect(store.sending).toBe(false);
  });

  it('runs a draft command on the sessionless runner and keeps the draft', async () => {
    const runner = runnerWith({
      runCommand: vi.fn(async () => ({ ok: true as const, hiddenUi: false })),
    });
    const store = storeWith(runner);
    store.newConversation({ path: '/p/a', name: 'a' });

    expect(await store.send('/thinking high')).toBe('sent');

    expect(runner.runCommand).toHaveBeenCalledWith(null, '/thinking high');
    expect(runner.beginStartNew).not.toHaveBeenCalled();
    // Nothing was written, so there is still no session file to adopt.
    expect(store.openPath).toBeNull();
    expect(store.startingNew).toBe(true);
  });

  it('notes a command whose screen only the terminal can show', async () => {
    const runner = runnerWith({
      runCommand: vi.fn(async () => ({ ok: true as const, hiddenUi: true })),
    });
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    expect(await store.send('/tree')).toBe('sent');
    expect(store.sendError).toBeNull();
    expect(store.sendNotice).toBe('该命令的界面只能在终端里显示。下一条消息会重新连接到本会话。');

    // The next send owns the slot again: a stale note must not sit over it.
    expect(await store.send('hi')).toBe('sent');
    expect(store.sendNotice).toBeNull();
  });

  it('reports a refused command as a send failure, not a timeout', async () => {
    const runner = runnerWith({
      runCommand: vi.fn(async () => ({ ok: false as const, error: 'This line is not a Pi command.' })),
    });
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    expect(await store.send('/compact')).toBe('error');
    expect(store.sendError).toBe('消息未发送成功，请重试。');
    expect(store.sendNotice).toBeNull();
    expect(store.sending).toBe(false);
  });

  it('sends a message that opens with a path as a turn, not a command', async () => {
    const runner = runnerWith();
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    expect(await store.send('/usr/bin/foo is broken')).toBe('sent');
    expect(runner.beginSend).toHaveBeenCalledWith('/r/a.jsonl', '/usr/bin/foo is broken');
    expect(runner.runCommand).not.toHaveBeenCalled();
  });

  it('drops a command whose chat closed before it settled', async () => {
    let settle!: (value: PiCommandRunResult) => void;
    const pendingCommand = new Promise<PiCommandRunResult>((resolve) => {
      settle = resolve;
    });
    const runner = runnerWith({ runCommand: vi.fn(() => pendingCommand) });
    const store = storeWith(runner, () => 'A');
    await store.openSession('/r/a.jsonl');

    const pending = store.send('/tree');
    store.closeChat();
    settle({ ok: true, hiddenUi: true });

    expect(await pending).toBe('error');
    expect(store.sendNotice).toBeNull();
    expect(store.sending).toBe(false);
  });
});
