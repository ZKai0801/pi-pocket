import { describe, expect, it, vi } from 'vitest';
import { createPiTurnRunner } from '../../src/pi/piTurnRunner';
import { PI_INPUT_READY_MARKER } from '../../src/pi/turnReadiness';
import type { ParsedPiSession } from '../../src/pi/types';
import type { TurnPtyHandle } from '../../src/session/turnPty';
import type { PiScreenDialog } from '../../src/pi/piDialog';

/** A confirm pane in the real pi shape (see piDialog.test.ts for the source). */
const CONFIRM_PANE = [
  '────────────────────────────────────────────────────────────────────────────────',
  '',
  ' Start fresh and delete current session',
  ' This will start a new session and permanently remove the current session from',
  ' your session history.',
  '',
  ' → Yes',
  '   No',
  '',
  ' ↑↓ navigate  enter select  escape/ctrl+c cancel',
  '',
].join('\n');

const IDLE_PANE = ['────────────────────────────────────────────────────────────────────────────', ''].join('\n');

/** An idle pane with pi's input box on it: what `/name` is typed into. */
const PROMPT_PANE = [
  '────────────────────────────────────────────────────────────────────────────',
  '',
  ' › ',
  '',
].join('\n');

/** The pane after `/name`: the box cleared, pi's confirmation under it. */
const NAMED_PANE = [
  '────────────────────────────────────────────────────────────────────────────',
  '',
  ' Session name set: ninfer-check',
  '',
  ' › ',
  '',
].join('\n');

/** The pane after Escape: the dialog is gone, the notify line stays. */
const CANCELLED_PANE = [
  '────────────────────────────────────────────────────────────────────────────────',
  ' /nix cancelled.',
  '',
].join('\n');

const SESSION: ParsedPiSession = {
  version: 3, id: 'a', cwd: '/p', name: null,
  turns: [{ role: 'user', text: 'hi', timestampMs: 1 }],
};

function handle(): TurnPtyHandle {
  const listeners = new Set<(chunk: string) => void>();
  return {
    write: vi.fn(),
    onData: vi.fn((callback: (chunk: string) => void) => {
      listeners.add(callback);
      callback(PI_INPUT_READY_MARKER);
      return () => listeners.delete(callback);
    }),
    close: vi.fn(),
    // These doubles are never killed, so the death watcher has nothing to hear.
    onClose: vi.fn(() => () => undefined),
  };
}

/**
 * A runner whose pane reads answer `before` first — the capture taken just
 * before the command is delivered — and then each of `panes` in turn.
 */
function harness(panes: string[], before: string = IDLE_PANE) {
  const queue = [...panes];
  let capturedBefore = false;
  const capturePane = vi.fn(async () => {
    if (!capturedBefore) {
      capturedBefore = true;
      return before;
    }
    return queue.shift() ?? IDLE_PANE;
  });
  const sendKeys = vi.fn(async () => undefined);
  const onDialog = vi.fn();
  const onCommandOutput = vi.fn();
  const runner = createPiTurnRunner({
    openPty: vi.fn(async () => handle()),
    piCommand: '/opt/bin/pi',
    projectPath: '/p',
    readSession: vi.fn(async () => SESSION),
    newestSessionFile: vi.fn(async () => null),
    capturePane,
    sendKeys,
    onDialog,
    onCommandOutput,
    sleep: vi.fn(async () => {}),
    dialogSettleMs: 0,
    submitDelayMs: 0,
    pollIntervalMs: 1,
  });
  return { runner, capturePane, sendKeys, onDialog, onCommandOutput };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe('dialog detection after a /command', () => {
  it('reports a dialog found on the pane, after the send itself settled', async () => {
    const { runner, onDialog } = harness([CONFIRM_PANE]);
    const delivered = await runner.runCommand('/r/a.jsonl', '/nix');
    // The delivery's own contract is untouched: settled on the write ack.
    expect(delivered).toEqual({ ok: true, hiddenUi: false });
    await flush();
    expect(onDialog).toHaveBeenCalledTimes(1);
    const event = onDialog.mock.calls[0]?.[0];
    expect(event.dialog.title).toBe('Start fresh and delete current session');
    expect(event.dialog.options).toEqual(['Yes', 'No']);
    expect(event.dialog.selected).toBe(0);
    expect(event.pane).toBe(CONFIRM_PANE);
    expect(event.sessionName).toMatch(/^ps-pi-/u);
  });

  it('stays silent on an idle pane', async () => {
    const { runner, onDialog } = harness([IDLE_PANE]);
    await runner.runCommand('/r/a.jsonl', '/compact');
    await flush();
    expect(onDialog).not.toHaveBeenCalled();
  });

  it('does not read the pane for a command that took the terminal over', async () => {
    const { runner, capturePane } = harness([]);
    await runner.runCommand('/r/a.jsonl', '/model');
    await flush();
    expect(capturePane).not.toHaveBeenCalled();
  });
});

describe('command output after a /command', () => {
  it('hands the chat the line pi printed for itself', async () => {
    const { runner, onCommandOutput } = harness([NAMED_PANE], PROMPT_PANE);
    await runner.runCommand('/r/a.jsonl', '/name ninfer-check');
    await flush();
    expect(onCommandOutput).toHaveBeenCalledTimes(1);
    expect(onCommandOutput.mock.calls[0]?.[0]).toEqual({
      sessionFile: '/r/a.jsonl',
      command: '/name ninfer-check',
      lines: ['Session name set: ninfer-check'],
    });
  });

  it('reports a draft command as belonging to no session file', async () => {
    const { runner, onCommandOutput } = harness([NAMED_PANE], PROMPT_PANE);
    await runner.runCommand(null, '/name ninfer-check');
    await flush();
    expect(onCommandOutput.mock.calls[0]?.[0].sessionFile).toBeNull();
  });

  it('says nothing when the command changed nothing on screen', async () => {
    const { runner, onCommandOutput } = harness([PROMPT_PANE], PROMPT_PANE);
    await runner.runCommand('/r/a.jsonl', '/name ninfer-check');
    await flush();
    expect(onCommandOutput).not.toHaveBeenCalled();
  });

  it('does not also report a dialog as output: the dialog is the output', async () => {
    const { runner, onCommandOutput } = harness([CONFIRM_PANE], IDLE_PANE);
    await runner.runCommand('/r/a.jsonl', '/nix');
    await flush();
    expect(onCommandOutput).not.toHaveBeenCalled();
  });
});

describe('answerDialog', () => {
  /** Detect the dialog first, as the real flow always does, and hand its event back. */
  async function detectDialog(panes: string[]) {
    const context = harness(panes);
    await context.runner.runCommand('/r/a.jsonl', '/nix');
    await flush();
    expect(context.onDialog).toHaveBeenCalledTimes(1);
    return { context, event: context.onDialog.mock.calls[0]![0] };
  }

  it('cancels with Escape and reports the notify line', async () => {
    const { context, event } = await detectDialog([CONFIRM_PANE, CANCELLED_PANE]);
    const answer = await context.runner.answerDialog(event.dialog, 'cancel', event.pane);
    expect(context.sendKeys).toHaveBeenCalledWith(event.sessionName, ['Escape']);
    expect(answer).toEqual({ ok: true, settled: true, newLines: ['/nix cancelled.'] });
  });

  it('confirm presses Enter on the highlighted affirmative option', async () => {
    const { context, event } = await detectDialog([CONFIRM_PANE, CANCELLED_PANE]);
    const answer = await context.runner.answerDialog(event.dialog, 'confirm', event.pane);
    expect(context.sendKeys).toHaveBeenCalledWith(event.sessionName, ['Enter']);
    expect(answer).toEqual({ ok: true, settled: true, newLines: ['/nix cancelled.'] });
  });

  it('keeps the dialog pending when the answer did not settle it', async () => {
    const { context, event } = await detectDialog([CONFIRM_PANE, CONFIRM_PANE]);
    const answer = await context.runner.answerDialog(event.dialog, 'cancel', event.pane);
    expect(context.sendKeys).toHaveBeenCalledWith(event.sessionName, ['Escape']);
    expect(answer.settled).toBe(false);
    expect(answer.newLines).toEqual([]);
  });

  it('cannot answer when the feature is not wired', async () => {
    const bare = createPiTurnRunner({
      openPty: vi.fn(async () => handle()),
      piCommand: '/opt/bin/pi',
      projectPath: '/p',
      readSession: vi.fn(async () => SESSION),
      newestSessionFile: vi.fn(async () => null),
      capturePane: vi.fn(async () => IDLE_PANE),
      sleep: vi.fn(async () => {}),
      submitDelayMs: 0,
      pollIntervalMs: 1,
    });
    const dialog: PiScreenDialog = { title: 't', message: [], options: ['Yes'], selected: 0 };
    const answer = await bare.answerDialog(dialog, 'confirm', CONFIRM_PANE);
    expect(answer).toEqual({ ok: false, settled: true, newLines: [] });
  });
});
