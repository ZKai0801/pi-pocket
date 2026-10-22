/**
 * Which typed lines are commands, and which of those take the terminal away
 * from this chat.
 *
 * The chat renders the session file, never the terminal: a command that opens
 * a picker or a full-screen surface draws into a PTY nobody watches, and a
 * command that moves pi to another conversation (`/new`, `/fork`, `/resume`)
 * leaves that PTY attached to a file this chat is not polling. Neither may
 * reach the next delivery — a picker treats the next line's Enter as "pick the
 * highlighted row", and a switched PTY answers into a conversation the chat
 * stopped reading.
 *
 * The runner therefore marks the turn PTY for a restart after such a command
 * and drops it before the next line, so the next send re-opens pi on the
 * chat's own session file. Deciding this here, from the line alone, keeps the
 * rule out of the terminal: parsing pi's redraws is exactly what the session
 * file exists to avoid (see `piTurnRunner`).
 */
import { toTurnLine } from './piTurn';

/** A line pi will read as a command rather than a prompt. */
export interface PiSlashLine {
  /** The flattened line exactly as it will be delivered. */
  line: string;
  /** The lower-cased command token, leading `/` included. */
  token: string;
  /** Everything after the token, trimmed; empty for the bare form. */
  argument: string;
}

/**
 * Commands whose BARE form opens a picker. The text form (`/model x`,
 * `/thinking high`) is ordinary input and must not cost a PTY restart — on a
 * draft chat the restart would also throw away the choice just made.
 */
const BARE_PICKER_COMMANDS: ReadonlySet<string> = new Set(['/model', '/thinking']);

/**
 * Commands that take over the whole terminal, or move pi to another
 * conversation. The app-shipped catalog marks these `tuiOnly`; `/model` and
 * `/thinking` are the two picker commands that have a text form instead.
 */
const TERMINAL_TAKEOVER_COMMANDS: ReadonlySet<string> = new Set([
  '/new',
  '/resume',
  '/tree',
  '/fork',
  '/clone',
  '/import',
  '/login',
  '/settings',
  '/scoped-models',
  '/hotkeys',
  '/trust',
  '/changelog',
]);

/**
 * A command token pi would accept: `/compact`, `/skill:deploy`, `/nix`.
 * Deliberately strict — the leading `/` is required and a second slash is
 * rejected, so a message that opens with a path (`/usr/bin/x is broken`) is
 * sent as a prompt instead of being mistaken for a command.
 */
const COMMAND_TOKEN = /^\/[a-z0-9][a-z0-9:_.-]*$/;

/** The command `text` carries, or null when it is a prompt. */
export function parseSlashLine(text: string): PiSlashLine | null {
  const line = toTurnLine(text);
  const space = line.indexOf(' ');
  const token = (space === -1 ? line : line.slice(0, space)).toLowerCase();
  if (!COMMAND_TOKEN.test(token)) return null;
  const argument = space === -1 ? '' : line.slice(space + 1).trim();
  return { line, token, argument };
}

/** The bare form opens a picker this chat has its own sheet for. */
export function opensBarePicker(slash: PiSlashLine): boolean {
  return slash.argument === '' && BARE_PICKER_COMMANDS.has(slash.token);
}

/**
 * True when the command leaves the turn PTY unusable for the chat's next
 * line: either a surface it cannot render, or another conversation.
 */
export function takesOverTerminal(slash: PiSlashLine): boolean {
  if (TERMINAL_TAKEOVER_COMMANDS.has(slash.token)) return true;
  return opensBarePicker(slash);
}
