import { describe, expect, it, vi } from 'vitest';
import type { PiTurnBegun, PiTurnRunner, PiTurnSendResult } from '../../src/pi/piTurnRunner';
import type { ParsedPiSession } from '../../src/pi/types';
import { createTurnRunnerFacade } from '../../src/stores/sessions';

const session: ParsedPiSession = {
  version: 3,
  id: 'new',
  cwd: '/p/a',
  name: null,
  turns: [
    { role: 'user', text: 'hi', timestampMs: 1 },
    { role: 'assistant', text: 'ok', timestampMs: 2 },
  ],
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function begunLater(completed: Promise<PiTurnSendResult>, sessionFile = '/r/new.jsonl'): PiTurnBegun {
  return { ok: true, sessionFile, completed };
}

function fakeRunner(overrides: Partial<PiTurnRunner> = {}): PiTurnRunner {
  return {
    send: vi.fn(async () => ({ ok: true as const, session })),
    startNew: vi.fn(async () => ({
      ok: true as const,
      sessionFile: '/r/new.jsonl',
      session,
    })),
    beginSend: vi.fn(async () => begunLater(Promise.resolve({ ok: true as const, session }), '/r/a.jsonl')),
    beginStartNew: vi.fn(async () => begunLater(Promise.resolve({ ok: true as const, session }))),
    queue: vi.fn(async () => ({ ok: true as const })),
    rebind: vi.fn(),
    isBusy: vi.fn(() => false),
    dispose: vi.fn(),
    ...overrides,
  };
}

function harness(
  draft: PiTurnRunner | (() => PiTurnRunner) = fakeRunner(),
  adopted: PiTurnRunner = fakeRunner(),
) {
  const draftFor = typeof draft === 'function' ? draft : () => draft;
  const runnerFor = vi.fn(async (sessionFile: string) =>
    sessionFile === '' ? draftFor() : adopted,
  );
  const release = vi.fn();
  const dispose = vi.fn();
  let startingNew = true;
  let openPath: string | null = null;
  const facade = createTurnRunnerFacade({
    runnerFor,
    release,
    rebind: vi.fn(),
    dispose,
    openPath: () => openPath,
    startingNew: () => startingNew,
  });
  return {
    facade,
    runnerFor,
    release,
    dispose,
    adopt(sessionFile: string): void {
      startingNew = false;
      openPath = sessionFile;
    },
  };
}

describe('turn runner facade', () => {
  it('hands the turn over once the draft file is adopted and releases its runner at the end', async () => {
    const completed = deferred<PiTurnSendResult>();
    const draft = fakeRunner({ beginStartNew: vi.fn(async () => begunLater(completed.promise)) });
    const h = harness(draft);

    const begun = await h.facade.beginStartNew('/p/a', 'hi');

    expect(begun).toMatchObject({ ok: true, sessionFile: '/r/new.jsonl' });
    // The sessionless PTY is still running this turn, so it is not released yet.
    expect(h.release).not.toHaveBeenCalled();

    completed.resolve({ ok: true, session });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.release).toHaveBeenCalledWith('');
  });

  it('releases the draft runner and refuses a retry once beginStartNew fails', async () => {
    const failedDraft = fakeRunner({
      beginStartNew: vi.fn(async () => ({ ok: false as const, error: 'No new session file appeared.' })),
    });
    const retryDraft = fakeRunner();
    let builds = 0;
    const h = harness(() => (builds++ === 0 ? failedDraft : retryDraft));

    await expect(h.facade.beginStartNew('/p/a', 'hi')).resolves.toEqual({
      ok: false,
      error: 'No new session file appeared.',
    });
    expect(h.release).toHaveBeenCalledWith('');
    expect(h.facade.isBusy()).toBe(false);

    await expect(h.facade.beginStartNew('/p/a', 'again')).resolves.toMatchObject({ ok: true });
    expect(h.runnerFor).toHaveBeenCalledTimes(2);
    expect(retryDraft.beginStartNew).toHaveBeenCalledTimes(1);
  });

  it('sends the following turn to the adopted path, not the draft slot', async () => {
    const h = harness();

    await expect(h.facade.beginStartNew('/p/a', 'hi')).resolves.toMatchObject({ ok: true });
    h.adopt('/r/new.jsonl');
    await expect(h.facade.beginSend('/r/new.jsonl', 'next')).resolves.toMatchObject({ ok: true });

    expect(h.runnerFor.mock.calls.map(([sessionFile]) => sessionFile)).toEqual([
      '',
      '/r/new.jsonl',
    ]);
  });

  it('refuses a second turn in the same conversation while one is running', async () => {
    const completed = deferred<PiTurnSendResult>();
    const runner = fakeRunner({ beginSend: vi.fn(async () => begunLater(completed.promise)) });
    const h = harness(fakeRunner(), runner);
    h.adopt('/r/a.jsonl');

    const first = await h.facade.beginSend('/r/a.jsonl', 'one');
    const second = await h.facade.beginSend('/r/a.jsonl', 'two');

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: expect.stringMatching(/running/i) });
    expect(runner.beginSend).toHaveBeenCalledTimes(1);

    completed.resolve({ ok: true, session });
    await Promise.resolve();
    await Promise.resolve();
    await expect(h.facade.beginSend('/r/a.jsonl', 'three')).resolves.toMatchObject({ ok: true });
  });

  it('runs two conversations at once and keeps the open one\'s runner warm', async () => {
    const first = deferred<PiTurnSendResult>();
    const second = deferred<PiTurnSendResult>();
    const runnerA = fakeRunner({ beginSend: vi.fn(async () => begunLater(first.promise, '/r/a.jsonl')) });
    const runnerB = fakeRunner({ beginSend: vi.fn(async () => begunLater(second.promise, '/r/b.jsonl')) });
    const runnerFor = vi.fn(async (sessionFile: string) => (sessionFile === '/r/a.jsonl' ? runnerA : runnerB));
    let openPath: string | null = '/r/a.jsonl';
    const release = vi.fn();
    const facade = createTurnRunnerFacade({
      runnerFor,
      release,
      rebind: vi.fn(),
      dispose: vi.fn(),
      openPath: () => openPath,
      startingNew: () => false,
    });

    await expect(facade.beginSend('/r/a.jsonl', 'one')).resolves.toMatchObject({ ok: true });
    openPath = '/r/b.jsonl';
    await expect(facade.beginSend('/r/b.jsonl', 'two')).resolves.toMatchObject({ ok: true });

    expect(runnerA.beginSend).toHaveBeenCalledTimes(1);
    expect(runnerB.beginSend).toHaveBeenCalledTimes(1);

    // The background chat gives its PTY back when its reply lands; the chat on
    // screen keeps its runner for the next message.
    first.resolve({ ok: true, session });
    await Promise.resolve();
    await Promise.resolve();
    expect(release).toHaveBeenCalledWith('/r/a.jsonl');

    second.resolve({ ok: true, session });
    await Promise.resolve();
    await Promise.resolve();
    expect(release).not.toHaveBeenCalledWith('/r/b.jsonl');
  });

  it('reports a stale chat instead of writing into it', async () => {
    const h = harness();
    h.adopt('/r/new.jsonl');

    await expect(h.facade.beginSend('/r/other.jsonl', 'hi')).resolves.toEqual({
      ok: false,
      error: 'The chat changed before the turn could start.',
    });
    await expect(h.facade.beginStartNew('/p/a', 'hi')).resolves.toEqual({
      ok: false,
      error: 'The chat changed before the turn could start.',
    });
  });

  it('refuses a turn whose runner could not be built and stays idle', async () => {
    const runnerFor = vi.fn(async () => {
      throw new Error('The chat changed before the turn could start.');
    });
    const facade = createTurnRunnerFacade({
      runnerFor,
      release: vi.fn(),
      rebind: vi.fn(),
      dispose: vi.fn(),
      openPath: () => '/r/a.jsonl',
      startingNew: () => false,
    });

    await expect(facade.beginSend('/r/a.jsonl', 'hi')).resolves.toEqual({
      ok: false,
      error: 'The chat changed before the turn could start.',
    });
    expect(facade.isBusy()).toBe(false);
  });
});
