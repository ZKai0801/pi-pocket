import { describe, expect, it, vi } from 'vitest';
import { createSessionsStore } from '../../src/stores/sessions';
import type { PiTurnRunner } from '../../src/pi/piTurnRunner';
import type { ParsedPiSession } from '../../src/pi/types';
import type { PiScreenDialog } from '../../src/pi/piDialog';

const session: ParsedPiSession = {
  version: 3, id: 'a', cwd: '/p', name: null,
  turns: [{ role: 'user', text: 'hi', timestampMs: 1 }],
};

const dialog: PiScreenDialog = {
  title: 'Start fresh and delete current session',
  message: [' This will start a new session and permanently remove it.'],
  options: ['Yes', 'No'],
  selected: 0,
};

function runnerWith(over: Partial<PiTurnRunner> = {}): PiTurnRunner {
  return {
    send: vi.fn(async () => ({ ok: true as const, session })),
    startNew: vi.fn(async () => ({ ok: true as const, sessionFile: '/r/new.jsonl', session })),
    beginSend: vi.fn(async () => ({ ok: true as const, sessionFile: '/r/a.jsonl', completed: Promise.resolve({ ok: true as const, session }) })),
    beginStartNew: vi.fn(async () => ({ ok: true as const, sessionFile: '/r/new.jsonl', completed: Promise.resolve({ ok: true as const, session }) })),
    runCommand: vi.fn(async () => ({ ok: true as const, hiddenUi: false })),
    answerDialog: vi.fn(async () => ({ ok: true as const, settled: true, newLines: [] })),
    queue: vi.fn(async () => ({ ok: true as const })),
    rebind: vi.fn(),
    isBusy: vi.fn(() => false),
    dispose: vi.fn(),
    ...over,
  };
}

function storeWith(runner: PiTurnRunner, runnerForDialog?: (sessionFile: string | null) => Promise<PiTurnRunner>) {
  return createSessionsStore({
    listSessions: vi.fn(async () => []),
    readSession: vi.fn(async () => session),
    runner,
    runnerForDialog,
  } as never);
}

describe('pending dialog gate', () => {
  it('refuses any send while a dialog is waiting, naming the dialog', async () => {
    const runner = runnerWith();
    const store = storeWith(runner);
    await store.openSession('/r/a.jsonl');
    store.pendingDialog = { sessionFile: '/r/a.jsonl', dialog, pane: 'before' };

    await expect(store.send('a message that must not reach the pane')).resolves.toBe('error');
    expect(runner.beginSend).not.toHaveBeenCalled();
    expect(store.sendError).toContain('Pi');
  });

  it('clears with the host switch: the old host\'s pane is unreachable', async () => {
    const store = storeWith(runnerWith());
    store.pendingDialog = { sessionFile: '/r/a.jsonl', dialog, pane: 'before' };
    store.hostChanged();
    expect(store.pendingDialog).toBeNull();
  });
});

describe('answerPendingDialog', () => {
  it('routes to the conversation\'s own runner and reports the notify line', async () => {
    const runner = runnerWith({
      answerDialog: vi.fn(async () => ({ ok: true as const, settled: true, newLines: [' /nix cancelled.'] })),
    });
    const routed: Array<string | null> = [];
    const store = storeWith(runner, async (sessionFile) => {
      routed.push(sessionFile);
      return runner;
    });
    await store.openSession('/r/a.jsonl');
    store.pendingDialog = { sessionFile: '/r/a.jsonl', dialog, pane: 'before' };

    await expect(store.answerPendingDialog('cancel')).resolves.toBe('answered');
    expect(routed).toEqual(['/r/a.jsonl']);
    expect(runner.answerDialog).toHaveBeenCalledWith(dialog, 'cancel', 'before');
    expect(store.pendingDialog).toBeNull();
    expect(store.sendNotice).toBe(' /nix cancelled.');
    // The gate lifted with the dialog.
    await expect(store.send('hello again')).resolves.toBe('sent');
  });

  it('keeps the dialog up when the answer did not settle it', async () => {
    const runner = runnerWith({
      answerDialog: vi.fn(async () => ({ ok: true as const, settled: false, newLines: [] })),
    });
    const store = storeWith(runner, async () => runner);
    store.pendingDialog = { sessionFile: '/r/a.jsonl', dialog, pane: 'before' };

    await expect(store.answerPendingDialog('confirm')).resolves.toBe('conflict');
    expect(store.pendingDialog).not.toBeNull();
  });

  it('does not double-answer while an answer is in flight', async () => {
    let release!: () => void;
    const runner = runnerWith({
      answerDialog: vi.fn(async () => {
        await new Promise<void>((done) => { release = done; });
        return { ok: true as const, settled: true, newLines: [] };
      }),
    });
    const store = storeWith(runner, async () => runner);
    store.pendingDialog = { sessionFile: '/r/a.jsonl', dialog, pane: 'before' };

    const first = store.answerPendingDialog('cancel');
    await expect(store.answerPendingDialog('confirm')).resolves.toBe('busy');
    expect(runner.answerDialog).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toBe('answered');
  });
});

describe('noteCommandOutput', () => {
  it('puts a command\'s own line after the turns that were on screen', async () => {
    const store = storeWith(runnerWith());
    await store.openSession('/r/a.jsonl');

    store.noteCommandOutput('/r/a.jsonl', '/name ninfer-check', ['Session name set: ninfer-check']);

    expect(store.commandNotes).toEqual([
      { id: 'command-note-1', text: 'Session name set: ninfer-check', afterTurns: 1 },
    ]);
  });

  it('says nothing for a command another chat ran', () => {
    const store = storeWith(runnerWith());
    store.openPath = '/r/other.jsonl';

    store.noteCommandOutput('/r/a.jsonl', '/name ninfer-check', ['Session name set: ninfer-check']);

    expect(store.commandNotes).toEqual([]);
  });

  it('leaves /model to the divider this store already paints', async () => {
    const store = storeWith(runnerWith());
    await store.openSession('/r/a.jsonl');

    store.noteCommandOutput('/r/a.jsonl', '/model openai/gpt-5.1-codex', ['Model set to openai/gpt-5.1-codex']);

    expect(store.commandNotes).toEqual([]);
  });

  it('drops blank lines instead of drawing empty rows', async () => {
    const store = storeWith(runnerWith());
    await store.openSession('/r/a.jsonl');

    store.noteCommandOutput('/r/a.jsonl', '/name ninfer-check', ['  ', 'Session name set: ninfer-check', '']);

    expect(store.commandNotes.map((note) => note.text)).toEqual(['Session name set: ninfer-check']);
  });
});
