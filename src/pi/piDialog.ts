/**
 * The one place this app reads pi's screen: an extension command's interactive
 * dialog (`ctx.ui.confirm(...)`, `ctx.ui.select?`) that draws into the turn's
 * hidden tmux pane. The chat still renders the session file, never the
 * terminal — but a dialog nobody can see would both strand the command and eat
 * the chat's next line (Enter answers the highlighted option, which for
 * `confirm` defaults to Yes), so the few seconds after a `/command` are the
 * one window where the screen is the only source of truth.
 *
 * tmux does the terminal emulation: `capture-pane -p` returns plain text, no
 * ANSI to parse. The shapes below are taken verbatim from a real
 * pi-session-cleanup `/nix` confirm captured on 2026-10-26:
 *
 * ```
 *  Start fresh and delete current session
 *  This will start a new session and permanently remove ...
 *  Current session:
 *  2026-10-25T22-18-35-068Z_...jsonl
 *
 *  → Yes
 *    No
 *
 *  ↑↓ navigate  enter select  escape/ctrl+c cancel
 * ```
 */
import { quoteShell } from './piCommands';
import { PI_TURN_TMUX_SOCKET } from './piTurn';

/** A selection dialog as pi drew it on screen. */
export interface PiScreenDialog {
  /** The dialog's heading line. */
  title: string;
  /** The message paragraphs between title and options, top-down, blanks kept. */
  message: string[];
  /** The selectable options in order, bare text (["Yes", "No"]). */
  options: string[];
  /** The index of the option pi highlights (the arrow marker). */
  selected: number;
}

/** The pane text the dialog was parsed from, for answering-time diffing. */
export interface PiScreenDialogEvent {
  dialog: PiScreenDialog;
  pane: string;
  /** The tmux session the dialog is pending in. */
  sessionName: string;
}

/** The footer hint pi prints under every selection surface. */
function isDialogFooter(line: string): boolean {
  const text = line.trim();
  return text.includes('navigate') && text.includes('select') && text.includes('cancel');
}

/** A horizontal rule pi uses to delimit its message area. */
function isRuleLine(line: string): boolean {
  return /^\s*[-─━─]{8,}\s*$/u.test(line);
}

/**
 * A selectable option: short, starts at the option column, optionally marked
 * with the selection arrow. Long wrapped sentences fail the length bar.
 */
function parseOption(line: string): { label: string; selected: boolean } | null {
  const match = /^ *(→)? *([^ ].{0,23}?) *$/u.exec(line);
  if (match === null) return null;
  const label = (match[2] ?? '').trim();
  if (label === '' || label.split(/\s+/u).length > 3) return null;
  return { label, selected: match[1] !== undefined };
}

/** The selection dialog currently on `pane`, or null when the screen is none. */
export function parseScreenDialog(pane: string): PiScreenDialog | null {
  const lines = pane.split('\n').map((line) => line.replace(/\r$/, ''));
  const footer = lines.findIndex(isDialogFooter);
  if (footer < 0) return null;

  // Options sit just above the footer, one blank between them.
  let index = footer - 1;
  while (index >= 0 && lines[index].trim() === '') index -= 1;
  // Collected bottom-up, then reversed: unshift while walking up would make
  // an earlier-recorded index point at the wrong row.
  const entries: Array<{ label: string; selected: boolean }> = [];
  while (index >= 0) {
    const option = parseOption(lines[index]);
    if (option === null) break;
    entries.push(option);
    index -= 1;
  }
  const marked = entries.findIndex((entry) => entry.selected);
  if (entries.length === 0 || marked < 0) return null;
  const options = entries.map((entry) => entry.label).reverse();
  const selected = entries.length - 1 - marked;

  // Title and message run up to the rule that delimits pi's message area.
  while (index >= 0 && lines[index].trim() === '') index -= 1;
  const body: string[] = [];
  while (index >= 0 && body.length < 16 && !isRuleLine(lines[index])) {
    body.unshift(lines[index].trimEnd());
    index -= 1;
  }
  // The dialog's own spacing may leave blanks at either end of the block.
  while (body.length > 0 && body[0].trim() === '') body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  const title = body[0]?.trim() ?? '';
  if (title === '') return null;
  return { title, message: body.slice(1), options, selected };
}

/** The keys tmux accepts from this feature; option text never reaches a key. */
const KNOWN_KEYS = new Set(['Escape', 'Enter', 'Up', 'Down', 'Left', 'Right']);

/** An affirmative option, in pi's own naming so far. */
function isAffirmative(option: string): boolean {
  return /^(yes|ok|confirm|sure|是|确定)/iu.test(option.trim());
}

/**
 * The keystrokes that answer `dialog` with `choice`. Cancel is Escape — the
 * footer's own promise. Confirm walks to the affirmative option (or the
 * highlighted one when no option reads as affirmative) and presses Enter.
 */
export function dialogAnswerKeys(dialog: PiScreenDialog, choice: 'confirm' | 'cancel'): string[] {
  if (choice === 'cancel') return ['Escape'];
  let target = dialog.options.findIndex((option) => isAffirmative(option));
  if (target < 0) target = dialog.selected;
  const keys: string[] = [];
  const diff = target - dialog.selected;
  for (let step = 0; step < Math.abs(diff); step += 1) keys.push(diff > 0 ? 'Down' : 'Up');
  keys.push('Enter');
  return keys;
}

/** The plain text of a turn session's screen, straight from tmux. */
export function capturePaneCommand(sessionName: string): string {
  return `tmux -L ${PI_TURN_TMUX_SOCKET} capture-pane -p -t ${quoteShell(sessionName)}`;
}

/** Feed keystrokes to the turn session pi is waiting in. */
export function sendKeysCommand(sessionName: string, keys: readonly string[]): string {
  if (keys.length === 0 || keys.some((key) => !KNOWN_KEYS.has(key))) {
    throw new Error('Unexpected dialog answer key');
  }
  return `tmux -L ${PI_TURN_TMUX_SOCKET} send-keys -t ${quoteShell(sessionName)} ${keys.join(' ')}`;
}

/**
 * The lines that appeared on `after` but not on `before` — how the chat reads
 * the `ctx.ui.notify(...)` line an answered dialog leaves behind
 * (` /nix cancelled.`).
 */
export function newPaneLines(before: string, after: string): string[] {
  const seen = new Set(before.split('\n').map((line) => line.trim()));
  const fresh: string[] = [];
  for (const raw of after.split('\n')) {
    const line = raw.trim();
    if (line === '' || seen.has(line) || isDialogFooter(raw) || isRuleLine(raw)) continue;
    fresh.push(line);
    seen.add(line);
  }
  return fresh;
}

/** A pane line without the glyphs pi draws in front of it (`›`, `❯`, `│`). */
function bareLine(line: string): string {
  return line.replace(/^[^\p{L}\p{N}/]+/u, '').trim();
}

/**
 * What a `/command` printed for itself — the `Session name set: abcde` kind of
 * line pi leaves on the screen, which a chat that renders the session file
 * would otherwise never show: the command appends no turn, and an extension's
 * notice leaves no entry at all.
 *
 * The input box's echo of the command is dropped, because pi redraws it as the
 * user types and again as the line is submitted; it is the one new line the
 * user already knows about.
 */
export function commandOutputLines(before: string, after: string, typed: string): string[] {
  const echo = bareLine(typed);
  return newPaneLines(before, after).filter((line) => bareLine(line) !== echo);
}
