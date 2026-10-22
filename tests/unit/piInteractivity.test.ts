import { describe, expect, it } from 'vitest';
import {
  opensBarePicker,
  parseSlashLine,
  takesOverTerminal,
} from '../../src/pi/piInteractivity';
import { PI_BUILTIN_COMMANDS } from '../../src/pi/piSlashCommands';

function slash(text: string) {
  const parsed = parseSlashLine(text);
  if (parsed === null) throw new Error(`not a command: ${text}`);
  return parsed;
}

describe('parseSlashLine', () => {
  it('splits the command token from its argument', () => {
    expect(parseSlashLine('/model anthropic/claude-sonnet-4')).toEqual({
      line: '/model anthropic/claude-sonnet-4',
      token: '/model',
      argument: 'anthropic/claude-sonnet-4',
    });
  });

  it('reads a bare command as having no argument', () => {
    expect(parseSlashLine('/compact')).toMatchObject({ token: '/compact', argument: '' });
    expect(parseSlashLine('/compact   ')).toMatchObject({ argument: '' });
  });

  it('lower-cases the token but keeps the delivered line as typed', () => {
    expect(parseSlashLine('/Model  openai/gpt-5')).toMatchObject({
      line: '/Model  openai/gpt-5',
      token: '/model',
    });
  });

  it('delivers a multi-line command as one line', () => {
    expect(parseSlashLine('/name my\nproject')).toEqual({
      line: '/name my project',
      token: '/name',
      argument: 'my project',
    });
  });

  it('keeps the colon form of a skill command', () => {
    expect(parseSlashLine('/skill:deploy now')).toMatchObject({
      token: '/skill:deploy',
      argument: 'now',
    });
  });

  it('treats a leading path as a prompt, not a command', () => {
    expect(parseSlashLine('/usr/bin/foo is broken')).toBeNull();
    expect(parseSlashLine('/etc/hosts')).toBeNull();
  });

  it('treats ordinary text, a lone slash and blank input as prompts', () => {
    expect(parseSlashLine('hello')).toBeNull();
    expect(parseSlashLine('/')).toBeNull();
    expect(parseSlashLine('   ')).toBeNull();
    expect(parseSlashLine('/-flag')).toBeNull();
  });
});

describe('opensBarePicker', () => {
  it('is true only for the bare form of a picker command', () => {
    expect(opensBarePicker(slash('/model'))).toBe(true);
    expect(opensBarePicker(slash('/thinking'))).toBe(true);
    expect(opensBarePicker(slash('/model openai/gpt-5'))).toBe(false);
    expect(opensBarePicker(slash('/compact'))).toBe(false);
  });
});

describe('takesOverTerminal', () => {
  it('is true for a bare picker command', () => {
    expect(takesOverTerminal(slash('/model'))).toBe(true);
    expect(takesOverTerminal(slash('/thinking'))).toBe(true);
  });

  it('is false for the text form, which is ordinary input', () => {
    // A restart here would throw away the choice just made on a draft chat.
    expect(takesOverTerminal(slash('/model openai/gpt-5'))).toBe(false);
    expect(takesOverTerminal(slash('/thinking high'))).toBe(false);
  });

  it('is false for commands that act on the conversation in place', () => {
    for (const line of ['/compact', '/compact keep the API notes', '/name fix', '/export /tmp/a.md']) {
      expect(takesOverTerminal(slash(line))).toBe(false);
    }
  });

  it('is true for a command that opens a full-screen surface or switches session', () => {
    for (const line of ['/tree', '/new', '/resume', '/fork', '/settings', '/login']) {
      expect(takesOverTerminal(slash(line))).toBe(true);
    }
  });

  it('is false for host-installed commands, whose behaviour the app cannot know', () => {
    expect(takesOverTerminal(slash('/nix'))).toBe(false);
    expect(takesOverTerminal(slash('/skill:deploy'))).toBe(false);
  });
});

describe('the takeover list matches the shipped catalog', () => {
  it('covers every command the catalog marks tuiOnly', () => {
    const tuiOnly = PI_BUILTIN_COMMANDS.filter((command) => command.tuiOnly === true);
    expect(tuiOnly.length).toBeGreaterThan(0);
    for (const command of tuiOnly) {
      expect(takesOverTerminal(slash(command.command))).toBe(true);
    }
  });

  it('adds nothing beyond the tuiOnly entries and the two picker commands', () => {
    const pickers = new Set(['/model', '/thinking']);
    for (const command of PI_BUILTIN_COMMANDS) {
      if (command.tuiOnly === true || pickers.has(command.command)) continue;
      expect(takesOverTerminal(slash(command.command))).toBe(false);
    }
  });
});
