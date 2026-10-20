import { describe, expect, it, vi } from 'vitest';
import type { PiTurnRunner } from '../../src/pi/piTurnRunner';
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

function fakeRunner(overrides: Partial<PiTurnRunner> = {}): PiTurnRunner {
  return {
    send: vi.fn(async () => ({ ok: true as const, session })),
    startNew: vi.fn(async () => ({
      ok: true as const,
      sessionFile: '/r/new.jsonl',
      session,
    })),
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
  const disposeChat = vi.fn();
  const dispose = vi.fn();
  let startingNew = true;
  let openPath: string | null = null;
  const facade = createTurnRunnerFacade({
    runnerFor,
    disposeChat,
    dispose,
    isBusy: () => false,
    openPath: () => openPath,
    startingNew: () => startingNew,
  });
  return {
    facade,
    runnerFor,
    disposeChat,
    dispose,
    adopt(sessionFile: string): void {
      startingNew = false;
      openPath = sessionFile;
    },
  };
}

describe('turn runner facade', () => {
  it('disposes the bare runner exactly once after startNew adopts a file', async () => {
    const h = harness();

    await expect(h.facade.startNew('/p/a', 'hi')).resolves.toEqual({
      ok: true,
      sessionFile: '/r/new.jsonl',
      session,
    });

    expect(h.disposeChat).toHaveBeenCalledTimes(1);
    expect(h.dispose).not.toHaveBeenCalled();
    expect(h.facade.isBusy()).toBe(false);
  });

  it('sends the following turn to the adopted path, not the draft slot', async () => {
    const h = harness();

    await expect(h.facade.startNew('/p/a', 'hi')).resolves.toMatchObject({ ok: true });
    h.adopt('/r/new.jsonl');
    await expect(h.facade.send('/r/new.jsonl', 'next')).resolves.toMatchObject({ ok: true });

    expect(h.runnerFor.mock.calls.map(([sessionFile]) => sessionFile)).toEqual([
      '',
      '/r/new.jsonl',
    ]);
  });

  it('disposes the bare runner and retries with a fresh runner when startNew fails', async () => {
    const failedDraft = fakeRunner({
      startNew: vi.fn(async () => ({
        ok: false as const,
        error: 'No new session file appeared.',
      })),
    });
    const retryDraft = fakeRunner();
    let builds = 0;
    const h = harness(() => (builds++ === 0 ? failedDraft : retryDraft));

    await expect(h.facade.startNew('/p/a', 'hi')).resolves.toEqual({
      ok: false,
      error: 'No new session file appeared.',
    });
    expect(h.disposeChat).toHaveBeenCalledTimes(1);
    expect(h.facade.isBusy()).toBe(false);

    await expect(h.facade.startNew('/p/a', 'again')).resolves.toMatchObject({ ok: true });
    expect(h.runnerFor).toHaveBeenCalledTimes(2);
    expect(failedDraft.startNew).toHaveBeenCalledTimes(1);
    expect(retryDraft.startNew).toHaveBeenCalledTimes(1);
    expect(h.disposeChat).toHaveBeenCalledTimes(2);
  });
});
