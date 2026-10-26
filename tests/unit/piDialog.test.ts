import { describe, expect, it } from 'vitest';
import {
  capturePaneCommand,
  commandOutputLines,
  dialogAnswerKeys,
  newPaneLines,
  parseScreenDialog,
  sendKeysCommand,
} from '../../src/pi/piDialog';

/**
 * Verbatim `tmux capture-pane -p` of a real pi-session-cleanup `/nix` confirm
 * on kai-server (2026-10-26): the shape every rule in this module follows.
 */
const NIX_CONFIRM_PANE = [
  ' Warning: tmux extended-keys is off. Modified Enter keys may not work. Add `set',
  ' -g extended-keys on` to ~/.tmux.conf and restart tmux.',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  '',
  ' Start fresh and delete current session',
  ' This will start a new session and permanently remove the current session from',
  ' your session history.',
  '',
  ' Current session:',
  ' 2026-10-25T22-18-35-068Z_01a17524-e6bb-709f-85e5-ffbc5a79055a.jsonl',
  '',
  ' Pi will try moving it to trash first, then permanently delete it if trash is',
  ' unavailable.',
  '',
  ' → Yes',
  '   No',
  '',
  ' ↑↓ navigate  enter select  escape/ctrl+c cancel',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  '/home/projects/Quant/quant-data (main)',
  '0.0%/131k (auto) ⚡ TPS: --                        (ninfer) qwen3.8-27b • medium',
  'on',
].join('\n');

const IDLE_PANE = [
  ' Warning: tmux extended-keys is off.',
  '',
  '────────────────────────────────────────────────────────────────────────────────',
  '/home/projects/Quant/quant-data (main)',
  '0.0%/131k (auto) ⚡ TPS: --',
].join('\n');

describe('parseScreenDialog', () => {
  it('reads the real /nix confirm: title, message, options, selection', () => {
    const dialog = parseScreenDialog(NIX_CONFIRM_PANE);
    expect(dialog).not.toBeNull();
    expect(dialog?.title).toBe('Start fresh and delete current session');
    expect(dialog?.options).toEqual(['Yes', 'No']);
    // Enter alone would confirm the deletion — the reason the chat gates sends.
    expect(dialog?.selected).toBe(0);
    expect(dialog?.message).toEqual([
      ' This will start a new session and permanently remove the current session from',
      ' your session history.',
      '',
      ' Current session:',
      ' 2026-10-25T22-18-35-068Z_01a17524-e6bb-709f-85e5-ffbc5a79055a.jsonl',
      '',
      ' Pi will try moving it to trash first, then permanently delete it if trash is',
      ' unavailable.',
    ]);
  });

  it('returns null for an idle prompt and for plain command output', () => {
    expect(parseScreenDialog(IDLE_PANE)).toBeNull();
    const help = [' /nix help', '        /nix quit', '        /nix agent [name]', ''].join('\n');
    expect(parseScreenDialog(help)).toBeNull();
  });

  it('returns null when no option is marked selected', () => {
    const broken = NIX_CONFIRM_PANE.replace(' → Yes', '   Yes');
    expect(parseScreenDialog(broken)).toBeNull();
  });
});

describe('dialogAnswerKeys', () => {
  const dialog = { title: 't', message: [], options: ['Yes', 'No'], selected: 0 };

  it('cancel is Escape, the footer promise', () => {
    expect(dialogAnswerKeys(dialog, 'cancel')).toEqual(['Escape']);
  });

  it('confirm presses Enter when the affirmative option is highlighted', () => {
    expect(dialogAnswerKeys({ ...dialog, selected: 0 }, 'confirm')).toEqual(['Enter']);
  });

  it('confirm walks to the affirmative option first when it is not highlighted', () => {
    expect(dialogAnswerKeys({ ...dialog, options: ['No', 'Yes'], selected: 0 }, 'confirm'))
      .toEqual(['Down', 'Enter']);
    expect(dialogAnswerKeys({ ...dialog, options: ['Yes', 'No'], selected: 1 }, 'confirm'))
      .toEqual(['Up', 'Enter']);
  });

  it('falls back to the highlighted option when none reads affirmative', () => {
    expect(dialogAnswerKeys({ ...dialog, options: ['Retry', 'Abort'], selected: 1 }, 'confirm'))
      .toEqual(['Enter']);
  });
});

describe('capture and send commands', () => {
  it('target the app-owned tmux socket and the quoted session', () => {
    expect(capturePaneCommand('ps-pi-1x2y3'))
      .toBe("tmux -L pocketshell-pi capture-pane -p -t 'ps-pi-1x2y3'");
    expect(sendKeysCommand('ps-pi-1x2y3', ['Escape']))
      .toBe("tmux -L pocketshell-pi send-keys -t 'ps-pi-1x2y3' Escape");
    expect(sendKeysCommand('ps-pi-1x2y3', ['Down', 'Enter']))
      .toBe("tmux -L pocketshell-pi send-keys -t 'ps-pi-1x2y3' Down Enter");
  });

  it('refuses keystrokes outside the answer vocabulary', () => {
    expect(() => sendKeysCommand('s', ['rm -rf' as unknown as 'Enter'])).toThrow();
    expect(() => sendKeysCommand('s', [])).toThrow();
  });
});

describe('newPaneLines', () => {
  it('finds the notify line an answered dialog leaves behind', () => {
    const before = NIX_CONFIRM_PANE;
    const after = NIX_CONFIRM_PANE
      .replace(' → Yes\n   No\n\n ↑↓ navigate  enter select  escape/ctrl+c cancel', '')
      .replace(' Warning: tmux extended-keys is off.', ' /nix cancelled.\n Warning: tmux extended-keys is off.');
    expect(newPaneLines(before, after)).toEqual(['/nix cancelled.']);
  });

  it('drops rules, footers and repeats', () => {
    const after = ['──────────────────────────────────────────', 'same line', 'same line', ''].join('\n');
    expect(newPaneLines('same line\n', after)).toEqual([]);
  });
});

describe('commandOutputLines', () => {
  /** The pane before `/name`: an empty prompt above the rule. */
  const BEFORE = ['────────────────────────────────────────────────────────────────────────────────', '', ' › ', ''].join('\n');

  it('keeps what the command printed for itself', () => {
    const after = [
      '────────────────────────────────────────────────────────────────────────────────',
      '',
      ' › /name ninfer-check',
      ' Session name set: ninfer-check',
      '',
    ].join('\n');
    expect(commandOutputLines(BEFORE, after, '/name ninfer-check'))
      .toEqual(['Session name set: ninfer-check']);
  });

  it('drops the input box\'s echo of the command the user typed', () => {
    const after = ['────────────────────────────────────────────────────────────────────────────────', '', ' › /name ninfer-check', ''].join('\n');
    expect(commandOutputLines(BEFORE, after, '/name ninfer-check')).toEqual([]);
  });

  it('reports nothing when the command changed nothing on screen', () => {
    expect(commandOutputLines(BEFORE, BEFORE, '/name ninfer-check')).toEqual([]);
  });
});
