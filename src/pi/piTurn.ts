import { piNodePathPrelude, quoteShell } from './piCommands';

/**
 * The private tmux server that carries Pi turns.
 *
 * ## Why a turn is not a bare `exec pi` any more
 *
 * A bare `exec` puts Pi inside the SSH PTY's process tree, so the agent lives
 * exactly as long as the phone's connection does: a reconnect (the phone's
 * `generationId` moves), the 90 s background grace expiring, a Wi-Fi/cellular
 * handover, or the app process being reaped all hang the PTY up and Pi dies
 * mid-turn. That is the opposite of what this app is built on — the terminal
 * tab survives all of it because it attaches to a server-side session, and a
 * chat turn has the same right to.
 *
 * So the turn is started on a tmux server of our own (`-L`, a socket under
 * `$TMUX_TMPDIR`, invisible to the user's own tmux servers and to aplexer's
 * session list) and the PTY only ever *attaches* to it. Losing the connection
 * detaches a client; it never signals the agent.
 *
 * ## Why the session name is derived, not remembered
 *
 * A reconnect builds a brand-new `PiTurnRunner` — the old one is bound to a
 * dead transport — and has to find the turn that is still running. The name is
 * therefore a pure function of the conversation (its session file, or the
 * project for a draft), so any process can recompute it: `attach-session` then
 * succeeds on a live turn and falls through to `new-session` on a finished one.
 *
 * ## Why the tmux call is wrapped in a capability test
 *
 * tmux is not guaranteed on a host (this app's own session runtime is aplexer,
 * D38), and a chat that refuses to send at all is worse than one that loses
 * its turn to a disconnect. Without tmux the command degrades to the old bare
 * `exec`, which is the pre-existing behaviour rather than a new failure.
 */
export const PI_TURN_TMUX_SOCKET = 'pocketshell-pi';

const TMUX_SESSION_PREFIX = 'ps-pi';

/**
 * Printed by the open command on the FIRST creation of a conversation's
 * session, before `new-session` runs.
 *
 * The runner needs to tell "Pi is booting" from "Pi is already up and tmux is
 * merely repainting it": a fresh Pi enables bracketed paste
 * (`PI_INPUT_READY_MARKER`) as it mounts its editor, but an attach to a live
 * session replays the screen and never re-sends that handshake, so waiting for
 * it there times out on a turn that is perfectly able to take input. The
 * marker is emitted on this PTY, never inside the pane, so it cannot be
 * mistaken for screen content when the pane is repainted.
 */
export const PI_TURN_CREATED_MARKER = '[ps-created]';

/**
 * 32-bit FNV-1a in base 36. Short, stable across platforms and app restarts,
 * and alphanumeric — tmux treats `.` and `:` in a session name as syntax.
 */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The tmux session a conversation's Pi runs under.
 *
 * A real conversation is named after its session file, so any process can
 * recompute the name and find a turn that is still running.
 *
 * A draft (`null`) gets a **fresh name every time**: it has no file to be named
 * by, and reusing one name would make the next `+` in the same project attach
 * to the previous draft's Pi. That turn is already writing a file, so no new
 * one ever appears and `pollForNewSessionFile` would wait out its deadline —
 * permanently, for as long as the stale session lived. A draft has nothing to
 * resume anyway: its file is adopted one turn after it starts.
 */
export function turnSessionName(sessionFile: string | null, projectPath: string): string {
  if (sessionFile === null) {
    return `${TMUX_SESSION_PREFIX}-draft-${shortHash(projectPath)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return `${TMUX_SESSION_PREFIX}-${shortHash(sessionFile)}`;
}

/**
 * The command Pi itself runs as: PATH bootstrap, the project directory, then
 * Pi on its session file. Identical to what the PTY used to exec directly, so
 * the node-on-PATH fix (`piNodePathPrelude`) still applies inside tmux — a
 * session's shell is non-login there too.
 */
export function buildPiInnerCommand(
  piCommand: string,
  projectPath: string,
  sessionFile?: string,
): string {
  const session = sessionFile === undefined ? '' : ` --session ${quoteShell(sessionFile)}`;
  return `${piNodePathPrelude(piCommand)} cd ${quoteShell(projectPath)} && exec ${quoteShell(piCommand)}${session}`;
}

/**
 * The PTY's own command: attach to the conversation's tmux session, creating
 * it on first use, and print nothing else.
 *
 * `-d` on attach detaches any client left over from a previous connection, so
 * the pane is always sized by the phone that is looking at it. `status off`
 * and `escape-time 0` are set on our own server only: the status line would
 * cost the TUI a row, and the default 500 ms escape timeout would make every
 * Alt+Enter (a follow-up) feel broken.
 *
 * The `sh -c` layer inside `new-session` pins the interpreter: tmux runs a
 * session command through the user's `default-shell`, which may be fish or
 * zsh, and this command is POSIX.
 */
export function buildPiOpenCommand(
  piCommand: string,
  projectPath: string,
  sessionFile?: string,
  sessionName?: string,
): string {
  if (/[\r\n]/.test(piCommand)) {
    throw new Error('A newline is not allowed in the pi command');
  }
  const inner = buildPiInnerCommand(piCommand, projectPath, sessionFile);
  // The caller passes the name when it also has to remember it (to tear the
  // session down later); a draft's name is not recomputable.
  const name = quoteShell(sessionName ?? turnSessionName(sessionFile ?? null, projectPath));
  const tmux = `tmux -L ${PI_TURN_TMUX_SOCKET}`;
  return [
    'if command -v tmux >/dev/null 2>&1; then',
    `${tmux} attach-session -d -t ${name} 2>/dev/null || {`,
    // Announce a fresh session before anything is drawn: the runner uses this
    // to know it has to wait for Pi's own startup handshake.
    `printf '\\n${PI_TURN_CREATED_MARKER}\\n';`,
    `${tmux} new-session -d -s ${name} ${quoteShell(`sh -c ${quoteShell(inner)}`)};`,
    `${tmux} set-option -g status off;`,
    `${tmux} set-option -g escape-time 0;`,
    `${tmux} attach-session -d -t ${name};`,
    '};',
    // The attach ends when the client detaches or the session dies; this PTY
    // then has nothing left to show, and a leftover prompt would keep the
    // channel open forever.
    'exit;',
    'fi;',
    inner,
  ].join(' ');
}

/**
 * Kill the conversation's tmux session. Run once a turn's reply has landed:
 * Pi's TUI would otherwise sit idle in a session nobody looks at, one node
 * process per conversation ever opened.
 */
export function buildPiCloseCommand(sessionName: string): string {
  const name = quoteShell(sessionName);
  return `tmux -L ${PI_TURN_TMUX_SOCKET} kill-session -t ${name} 2>/dev/null || true`;
}

/** A multi-line message is delivered as one line of terminal input. */
export function toTurnLine(message: string): string {
  return message.replace(/[\r\n]+/g, ' ').trim();
}
