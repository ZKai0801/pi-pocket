import { describe, expect, it, vi } from 'vitest';
import type { ParsedPiSession } from '../../src/pi/types';
import { createSessionsStore, localiseTurnError } from '../../src/stores/sessions';

const session: ParsedPiSession = {
  version: 3,
  id: 'a',
  cwd: '/home/kai',
  name: null,
  turns: [{ role: 'user', text: 'hi', timestampMs: 1 }],
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runnerWith(
  send: (path: string, text: string) => Promise<unknown>,
  busy = false,
  startNew: (projectPath: string, text: string) => Promise<unknown> = async () => ({
    ok: false,
    error: 'unused',
  }),
) {
  return {
    send: vi.fn(send),
    startNew: vi.fn(startNew),
    isBusy: vi.fn(() => busy),
    dispose: vi.fn(),
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
  it('replaces the open session with the one the runner read back', async () => {
    const replied = {
      ...session,
      turns: [...session.turns, { role: 'assistant' as const, text: 'ok', timestampMs: 2 }],
    };
    const runner = runnerWith(async () => ({ ok: true, session: replied }));
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    expect(await store.send('hi')).toBe('sent');
    expect(runner.send).toHaveBeenCalledWith('/r/a.jsonl', 'hi');
    expect(store.open).toEqual(replied);
    expect(store.sending).toBe(false);
    expect(store.sendError).toBeNull();
  });

  it('returns busy without writing when a turn is in flight', async () => {
    const runner = runnerWith(async () => ({ ok: true, session }), true);
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    expect(await store.send('hi')).toBe('busy');
    expect(runner.send).not.toHaveBeenCalled();
    expect(store.sending).toBe(false);
  });

  it('reports a localised error without throwing', async () => {
    const runner = runnerWith(async () => ({
      ok: false,
      error: 'The turn timed out before Pi wrote a new assistant reply.',
    }));
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    expect(await store.send('hi')).toBe('error');
    expect(store.sendError).toBe('等待回复超时，请重试。');
    expect(store.sendError).not.toContain('timed out');
    expect(store.sending).toBe(false);
  });

  it('refuses to send with no open session', async () => {
    const runner = runnerWith(async () => ({ ok: true, session }));
    const store = storeWith(runner);

    expect(await store.send('hi')).toBe('error');
    expect(runner.send).not.toHaveBeenCalled();
    expect(store.sendError).not.toBeNull();
  });

  it('refuses empty or whitespace text without calling the runner', async () => {
    const runner = runnerWith(async () => ({ ok: true, session }));
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    expect(await store.send('   ')).toBe('error');
    expect(store.sendError).toBe('消息为空。');
    expect(runner.send).not.toHaveBeenCalled();
  });

  it('toggles sending while the turn is in flight', async () => {
    const turn = deferred<{ ok: true; session: ParsedPiSession }>();
    const runner = runnerWith(() => turn.promise);
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');

    const pending = store.send('hi');
    expect(store.sending).toBe(true);
    expect(store.sendError).toBeNull();
    turn.resolve({ ok: true, session });
    await pending;
    expect(store.sending).toBe(false);
  });

  it('drops a send that settles after the host changed', async () => {
    const turn = deferred<{ ok: true; session: ParsedPiSession }>();
    const runner = runnerWith(() => turn.promise);
    let host = 'A';
    const store = storeWith(runner, () => host);
    await store.openSession('/r/a.jsonl');

    const pending = store.send('hi');
    host = 'B';
    store.hostChanged();
    turn.resolve({
      ok: true,
      session: { ...session, turns: [...session.turns, { role: 'assistant', text: 'stale', timestampMs: 2 }] },
    });
    await pending;

    expect(store.open?.turns).toHaveLength(1);
    expect(store.sendError).toBeNull();
    expect(store.sending).toBe(false);
  });

  it('drops a send when the host dep changes without a hostChanged signal', async () => {
    const turn = deferred<{ ok: true; session: ParsedPiSession }>();
    const runner = runnerWith(() => turn.promise);
    let host = 'A';
    const store = storeWith(runner, () => host);
    await store.openSession('/r/a.jsonl');

    const pending = store.send('hi');
    host = 'B';
    turn.resolve({
      ok: true,
      session: { ...session, turns: [...session.turns, { role: 'assistant', text: 'stale', timestampMs: 2 }] },
    });

    expect(await pending).toBe('error');
    expect(store.open?.turns).toHaveLength(1);
    expect(store.sendError).toBeNull();
    expect(store.sending).toBe(false);
  });

  it('reports an error when the runner rejects without throwing', async () => {
    const runner = runnerWith(async () => {
      throw new Error('This turn runner has been disposed.');
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
    const runner = runnerWith(async () => ({
      ok: false,
      error: 'The turn timed out before Pi wrote a new assistant reply.',
    }));
    const store = storeWith(runner, () => 'A');
    await store.openSession('/r/a.jsonl');
    await store.send('hi');
    expect(store.sendError).toBe('等待回复超时，请重试。');

    store.hostChanged();
    expect(store.sendError).toBeNull();
  });

  it('clears the last send error when another project loads', async () => {
    const runner = runnerWith(async () => ({
      ok: false,
      error: 'The turn timed out before Pi wrote a new assistant reply.',
    }));
    const store = storeWith(runner, () => 'A');
    await store.openSession('/r/a.jsonl');
    await store.send('hi');
    expect(store.sendError).toBe('等待回复超时，请重试。');

    await store.load({ path: '/p/b', name: 'b' });
    expect(store.sendError).toBeNull();
  });

  it('newConversation opens an empty draft chat for the selected project', () => {
    const runner = runnerWith(async () => ({ ok: true, session }));
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

  it('sends the first draft message through startNew and adopts the new file', async () => {
    const replied = {
      ...session,
      id: 'new',
      cwd: '/p/a',
      turns: [...session.turns, { role: 'assistant' as const, text: 'ok', timestampMs: 2 }],
    };
    const runner = runnerWith(
      async () => ({ ok: true, session }),
      false,
      async () => ({ ok: true, sessionFile: '/r/new.jsonl', session: replied }),
    );
    const store = storeWith(runner);
    store.newConversation({ path: '/p/a', name: 'a' });

    expect(await store.send('hi')).toBe('sent');

    expect(runner.startNew).toHaveBeenCalledWith('/p/a', 'hi');
    expect(runner.send).not.toHaveBeenCalled();
    expect(store.open).toEqual(replied);
    expect(store.openPath).toBe('/r/new.jsonl');
    expect(store.startingNew).toBe(false);
    expect(store.sending).toBe(false);
    expect(store.sendError).toBeNull();
  });

  it('keeps the draft chat when startNew fails', async () => {
    const runner = runnerWith(
      async () => ({ ok: true, session }),
      false,
      async () => ({
        ok: false,
        error: 'No new session file appeared before the timeout.',
      }),
    );
    const store = storeWith(runner);
    store.newConversation({ path: '/p/a', name: 'a' });

    expect(await store.send('hi')).toBe('error');

    expect(store.open).toEqual({ version: 3, id: '', cwd: '/p/a', name: null, turns: [] });
    expect(store.openPath).toBeNull();
    expect(store.startingNew).toBe(true);
    expect(store.sending).toBe(false);
    expect(store.sendError).toBe('新会话创建超时，请重试。');
  });

  it('drops a draft turn whose project changed before it settled', async () => {
    const turn = deferred<{ ok: true; sessionFile: string; session: ParsedPiSession }>();
    const runner = runnerWith(async () => ({ ok: true, session }), false, () => turn.promise);
    const store = storeWith(runner, () => 'A');
    store.newConversation({ path: '/p/a', name: 'a' });

    const pending = store.send('hi');
    const switched = { version: 3, id: '', cwd: '/p/b', name: null, turns: [] };
    store.open = switched;
    turn.resolve({
      ok: true,
      sessionFile: '/r/stale.jsonl',
      session: {
        ...session,
        cwd: '/p/a',
        turns: [...session.turns, { role: 'assistant', text: 'stale', timestampMs: 2 }],
      },
    });

    expect(await pending).toBe('error');
    expect(store.open).toEqual(switched);
    expect(store.openPath).toBeNull();
    expect(store.startingNew).toBe(true);
    expect(store.sendError).toBeNull();
    expect(store.sending).toBe(false);
  });

  it('maps every runner failure string to its own copy', () => {
    const cases: Array<[string, string]> = [
      ['A turn is already running in this chat.', '上一条消息仍在处理中，请稍候。'],
      ['This turn runner has been disposed.', '当前会话已断开，请重新打开。'],
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
});
