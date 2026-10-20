import { describe, expect, it, vi } from 'vitest';
import type { ParsedPiSession } from '../../src/pi/types';
import { createSessionsStore } from '../../src/stores/sessions';

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

function runnerWith(send: (path: string, text: string) => Promise<unknown>, busy = false) {
  return {
    send: vi.fn(send),
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
});
