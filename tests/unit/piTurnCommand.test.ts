import { describe, expect, it } from 'vitest';
import { piNodePathPrelude } from '../../src/pi/piCommands';
import { buildPiOpenCommand, toTurnLine } from '../../src/pi/piTurn';

// The turn PTY is a non-login shell, so pi cannot count on `node` being on
// PATH; every open command starts with the bootstrap that puts it there.
const PRELUDE = piNodePathPrelude('/opt/bin/pi');

describe('pi turn command', () => {
  it('opens pi in the project directory on the session file', () => {
    expect(buildPiOpenCommand('/opt/bin/pi', '/home/projects/x', '/r/a.jsonl'))
      .toBe(`${PRELUDE} cd '/home/projects/x' && exec '/opt/bin/pi' --session '/r/a.jsonl'`);
  });

  it('opens a new conversation when no session file is given', () => {
    const command = buildPiOpenCommand('/opt/bin/pi', '/home/projects/x');
    expect(command).toBe(`${PRELUDE} cd '/home/projects/x' && exec '/opt/bin/pi'`);
    expect(command).not.toContain('--session');
  });

  it('puts node on PATH before it runs pi', () => {
    // pi is `#!/usr/bin/env node`; a non-login shell has no node on PATH on
    // the target host, so pi exited 127 before it could paint its editor.
    expect(PRELUDE).toContain('command -v node >/dev/null 2>&1 ||');
    expect(PRELUDE).toContain("in '/opt/bin'");
    expect(PRELUDE).toContain('export PATH');
  });

  it('quotes a project path containing a space as one shell argument', () => {
    expect(buildPiOpenCommand('pi', '/home/my projects/x', '/r/a.jsonl'))
      .toContain("cd '/home/my projects/x' && exec");
  });

  it("keeps quotes, dollars and backticks in the path and command as data", () => {
    const command = buildPiOpenCommand(
      "pi'$(id)`whoami`",
      "/home/it's $HOME `id`",
      '/r/a.jsonl',
    );
    expect(command).toBe(
      piNodePathPrelude("pi'$(id)`whoami`")
      + " cd '/home/it'\\''s $HOME `id`' && exec 'pi'\\''$(id)`whoami`' --session '/r/a.jsonl'",
    );
  });

  it('rejects a pi command containing a newline', () => {
    expect(() => buildPiOpenCommand('pi\nrm -rf /', '/home/x')).toThrow(/newline/i);
    expect(() => buildPiOpenCommand('pi\r', '/home/x')).toThrow(/newline/i);
  });

  it('collapses a multi-line message into one line', () => {
    expect(toTurnLine('a\nb')).toBe('a b');
    expect(toTurnLine('a\r\n\r\nb')).toBe('a b');
    expect(toTurnLine('  x  ')).toBe('x');
    expect(toTurnLine('')).toBe('');
  });
});
