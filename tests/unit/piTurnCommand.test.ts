import { describe, expect, it } from 'vitest';
import { piNodePathPrelude, quoteShell } from '../../src/pi/piCommands';
import {
  buildPiCloseCommand,
  buildPiInnerCommand,
  buildPiOpenCommand,
  PI_TURN_TMUX_SOCKET,
  toTurnLine,
  turnSessionName,
} from '../../src/pi/piTurn';

// The turn runs as a non-login shell inside tmux too, so pi cannot count on
// `node` being on PATH; every open command still starts with the bootstrap.
const PRELUDE = piNodePathPrelude('/opt/bin/pi');
const TMUX = `tmux -L ${PI_TURN_TMUX_SOCKET}`;

/**
 * Decode one level of `quoteShell`'s single-quote form. Used to prove the
 * tmux layer hands the inner command over untouched — the whole point of the
 * doubling is that the second shell parses it back to exactly what the first
 * one built.
 */
function unquoteSingle(quoted: string): string {
  expect(quoted.startsWith("'")).toBe(true);
  expect(quoted.endsWith("'")).toBe(true);
  return quoted.slice(1, -1).split("'\\''").join("'");
}

describe('pi turn command', () => {
  it('runs pi inside a tmux session of our own, not the SSH PTY', () => {
    const command = buildPiOpenCommand('/opt/bin/pi', '/home/projects/x', '/r/a.jsonl');
    const name = quoteShell(turnSessionName('/r/a.jsonl', '/home/projects/x'));

    expect(command.startsWith('if command -v tmux >/dev/null 2>&1; then ')).toBe(true);
    // Attach first (a turn that outlived the last connection), create on miss.
    expect(command).toContain(`${TMUX} attach-session -d -t ${name} 2>/dev/null || {`);
    expect(command).toContain(`${TMUX} new-session -d -s ${name} `);
    // A leftover prompt would keep the old channel open forever.
    expect(command).toContain('}; exit; fi; ');
    // Without tmux the command degrades to the pre-existing bare exec.
    expect(command.endsWith(buildPiInnerCommand('/opt/bin/pi', '/home/projects/x', '/r/a.jsonl')))
      .toBe(true);
  });

  it('names the tmux session after the conversation, stably', () => {
    const first = turnSessionName('/r/a.jsonl', '/home/projects/x');
    expect(turnSessionName('/r/a.jsonl', '/home/projects/x')).toBe(first);
    expect(turnSessionName('/r/b.jsonl', '/home/projects/x')).not.toBe(first);
    // tmux parses `.` and `:` in a session name as syntax.
    expect(first).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('gives every draft its own session, named after the project', () => {
    const first = turnSessionName(null, '/home/projects/x');
    const second = turnSessionName(null, '/home/projects/x');
    // A reused draft name would make the next `+` attach to the previous
    // draft's Pi, whose turn already wrote the file the caller waits for.
    expect(first).not.toBe(second);
    expect(first.startsWith('ps-pi-draft-')).toBe(true);
    expect(first).toMatch(/^[A-Za-z0-9-]+$/);
    // A real conversation stays recomputable, which is what a reconnect needs.
    expect(turnSessionName('/r/a.jsonl', '/home/projects/x'))
      .toBe(turnSessionName('/r/a.jsonl', '/home/projects/y'));
  });

  it('turns the tmux status line off and keeps Alt+Enter prompt', () => {
    const command = buildPiOpenCommand('pi', '/home/x', '/r/a.jsonl');
    // A status row would cost the TUI one line; the 500 ms escape timeout
    // would swallow the follow-up key.
    expect(command).toContain(`${TMUX} set-option -g status off;`);
    expect(command).toContain(`${TMUX} set-option -g escape-time 0;`);
  });

  it('pins the inner interpreter, because tmux runs a session through the user shell', () => {
    const command = buildPiOpenCommand('pi', '/home/x', '/r/a.jsonl');
    const marker = 'new-session -d -s ';
    const rest = command.slice(command.indexOf(marker) + marker.length);
    const quoted = rest.slice(rest.indexOf(' ') + 1, rest.indexOf('; tmux'));

    // One level of quoting survives the tmux layer, the second reaches pi.
    const first = unquoteSingle(quoted);
    expect(first.startsWith("sh -c '")).toBe(true);
    expect(unquoteSingle(first.slice('sh -c '.length)))
      .toBe(buildPiInnerCommand('pi', '/home/x', '/r/a.jsonl'));
  });

  it('keeps quotes, dollars and backticks in the path and command as data', () => {
    const piCommand = "pi'$(id)`whoami`";
    const projectPath = "/home/it's $HOME `id`";
    const inner = buildPiInnerCommand(piCommand, projectPath, '/r/a.jsonl');

    expect(inner).toBe(
      piNodePathPrelude(piCommand)
      + " cd '/home/it'\\''s $HOME `id`' && exec 'pi'\\''$(id)`whoami`' --session '/r/a.jsonl'",
    );

    const command = buildPiOpenCommand(piCommand, projectPath, '/r/a.jsonl');
    const quoted = command.slice(
      command.indexOf('new-session -d -s ') + 'new-session -d -s '.length,
    );
    const sessionArg = quoted.slice(0, quoted.indexOf(' '));
    const payload = quoted.slice(quoted.indexOf(' ') + 1, quoted.indexOf('; tmux'));
    expect(unquoteSingle(sessionArg))
      .toBe(turnSessionName('/r/a.jsonl', projectPath));
    expect(unquoteSingle(unquoteSingle(payload).slice('sh -c '.length))).toBe(inner);
  });

  it('puts node on PATH before it runs pi', () => {
    // pi is `#!/usr/bin/env node`; a non-login shell has no node on PATH on
    // the target host, so pi exited 127 before it could paint its editor.
    expect(PRELUDE).toContain('command -v node >/dev/null 2>&1 ||');
    expect(PRELUDE).toContain("in '/opt/bin'");
    expect(PRELUDE).toContain('export PATH');
    expect(buildPiOpenCommand('/opt/bin/pi', '/home/x', '/r/a.jsonl')).toContain(PRELUDE);
  });

  it('rejects a pi command containing a newline', () => {
    expect(() => buildPiOpenCommand('pi\nrm -rf /', '/home/x')).toThrow(/newline/i);
    expect(() => buildPiOpenCommand('pi\r', '/home/x')).toThrow(/newline/i);
  });
});

describe('pi turn inner command', () => {
  it('opens pi in the project directory on the session file', () => {
    expect(buildPiInnerCommand('/opt/bin/pi', '/home/projects/x', '/r/a.jsonl'))
      .toBe(`${PRELUDE} cd '/home/projects/x' && exec '/opt/bin/pi' --session '/r/a.jsonl'`);
  });

  it('opens a new conversation when no session file is given', () => {
    const command = buildPiInnerCommand('/opt/bin/pi', '/home/projects/x');
    expect(command).toBe(`${PRELUDE} cd '/home/projects/x' && exec '/opt/bin/pi'`);
    expect(command).not.toContain('--session');
  });

  it('quotes a project path containing a space as one shell argument', () => {
    expect(buildPiInnerCommand('pi', '/home/my projects/x', '/r/a.jsonl'))
      .toContain("cd '/home/my projects/x' && exec");
  });
});

describe('pi turn teardown', () => {
  it('kills the conversation session and never fails a turn over it', () => {
    const name = turnSessionName('/r/a.jsonl', '/home/projects/x');
    const command = buildPiCloseCommand(name);
    expect(command).toContain(`${TMUX} kill-session -t '${name}'`);
    expect(command.endsWith('|| true')).toBe(true);
  });
});

describe('toTurnLine', () => {
  it('collapses a multi-line message into one line', () => {
    expect(toTurnLine('a\nb')).toBe('a b');
    expect(toTurnLine('a\r\n\r\nb')).toBe('a b');
    expect(toTurnLine('  x  ')).toBe('x');
    expect(toTurnLine('')).toBe('');
  });
});
