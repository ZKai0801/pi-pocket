import { describe, expect, it } from 'vitest';
import {
  PI_BUILTIN_COMMANDS,
  PI_COMMAND_GROUPS,
  commandDescription,
  discoverPiCommands,
  filterPiCommands,
  groupPiCommands,
  insertionFor,
  mergePiCommands,
  parsePiSlashProbe,
} from '../../src/pi/piSlashCommands';
import { piSlashProbeCommand, PI_SLASH_PROBE_MARKER } from '../../src/pi/piCommands';
import type { PiTransport } from '../../src/pi/piRepository';

function transport(stdout: string, exitCode = 0, stderr = ''): PiTransport {
  return {
    exec: async () => ({ stdout, stderr, exitCode }),
    sftpRead: async () => '',
  };
}

describe('pi built-in command catalog', () => {
  it('is unique, slash-prefixed and inside the known sections', () => {
    const tokens = PI_BUILTIN_COMMANDS.map((command) => command.command);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const command of PI_BUILTIN_COMMANDS) {
      expect(command.command.startsWith('/')).toBe(true);
      expect(command.command).not.toContain(' ');
      expect(PI_COMMAND_GROUPS).toContain(command.group);
      expect(command.descriptionKey).toBeDefined();
    }
  });

  it('omits /quit, which would end the process this chat drives', () => {
    expect(PI_BUILTIN_COMMANDS.map((command) => command.command)).not.toContain('/quit');
  });

  it('keeps a trailing space only for commands that take an argument', () => {
    const model = PI_BUILTIN_COMMANDS.find((command) => command.command === '/model');
    const copy = PI_BUILTIN_COMMANDS.find((command) => command.command === '/copy');
    const skill = PI_BUILTIN_COMMANDS.find((command) => command.command === '/skill:');
    expect(model && insertionFor(model)).toBe('/model ');
    expect(copy && insertionFor(copy)).toBe('/copy');
    expect(skill && insertionFor(skill)).toBe('/skill:');
  });
});

describe('parsePiSlashProbe', () => {
  it('maps extension commands, templates and skills to their groups', () => {
    const parsed = parsePiSlashProbe([
      'cmd\tnix\t/home/dev/.pi/agent/extensions',
      'tpl\treview\t/home/dev/.pi/agent/prompts',
      'skill\tdeploy\t/home/dev/git/app/.pi/skills',
      '',
    ].join('\n'));

    expect(parsed).toEqual([
      { command: '/nix', group: 'extension', source: 'agent/extensions' },
      { command: '/review', group: 'template', source: 'agent/prompts' },
      { command: '/skill:deploy', group: 'skill', source: '.pi/skills' },
    ]);
  });

  it('drops malformed, unknown and duplicate lines', () => {
    const parsed = parsePiSlashProbe([
      'garbage',
      'cmd\twith space\t/home/dev/.pi/agent/extensions',
      'cmd\tquery\t/home/dev/.pi/agent/extensions',
      'skill\tSKILL\t/home/dev/.pi/agent/skills',
      'unknown\tthing\t/somewhere',
      'cmd\tquery\t/home/dev/git/app/.pi/extensions',
      '\r',
    ].join('\n'));

    expect(parsed.map((command) => command.command)).toEqual(['/query']);
  });

  it('returns nothing for empty output', () => {
    expect(parsePiSlashProbe('')).toEqual([]);
  });
});

describe('mergePiCommands', () => {
  it('appends host commands after the built-ins and never shadows one', () => {
    const merged = mergePiCommands(parsePiSlashProbe([
      'cmd\tnix\t/home/dev/.pi/agent/extensions',
      'cmd\tmodel\t/home/dev/.pi/agent/extensions',
      'tpl\tdeploy\t/home/dev/.pi/agent/prompts',
    ].join('\n')));

    expect(merged.slice(0, PI_BUILTIN_COMMANDS.length)).toEqual([...PI_BUILTIN_COMMANDS]);
    const tail = merged.slice(PI_BUILTIN_COMMANDS.length).map((command) => command.command);
    // `model` collides with the built-in `/model`, so only the two new ones land.
    expect(tail).toEqual(['/nix', '/deploy']);
  });

  it('still returns the built-ins with an empty discovery', () => {
    expect(mergePiCommands([])).toHaveLength(PI_BUILTIN_COMMANDS.length);
  });
});

describe('filterPiCommands and groupPiCommands', () => {
  const commands = mergePiCommands(parsePiSlashProbe('cmd\tnix\t/home/dev/.pi/agent/extensions'));

  it('matches the token, the localised description and the source', () => {
    expect(filterPiCommands(commands, 'nix').map((command) => command.command)).toEqual(['/nix']);
    expect(filterPiCommands(commands, 'agent/extensions').map((command) => command.command)).toEqual(['/nix']);
    expect(filterPiCommands(commands, '模型').map((command) => command.command)).toContain('/model');
    expect(filterPiCommands(commands, 'NO-SUCH-COMMAND')).toEqual([]);
    expect(filterPiCommands(commands, '')).toHaveLength(commands.length);
  });

  it('groups in the declared section order and skips empty sections', () => {
    const sections = groupPiCommands(commands);
    expect(sections.map((section) => section.group)).toEqual([
      'session',
      'model',
      'share',
      'runtime',
      'extension',
    ]);
    expect(sections[sections.length - 1]?.commands[0]?.command).toBe('/nix');
  });

  it('describes a host command by where it came from', () => {
    const nix = commands.find((command) => command.command === '/nix');
    expect(nix && commandDescription(nix)).toBe('来自 agent/extensions');
  });
});

describe('piSlashProbeCommand', () => {
  it('starts with the marker and quotes the project directory', () => {
    const command = piSlashProbeCommand("/home/dev/my projects/app's");
    expect(command.startsWith(PI_SLASH_PROBE_MARKER)).toBe(true);
    expect(command).toContain(`'/home/dev/my projects/app'\\''s'/.pi`);
    expect(command).toContain('$HOME/.pi/agent');
    expect(command.endsWith('true')).toBe(true);
  });

  it('scans discovered agent roots before the default one', () => {
    const command = piSlashProbeCommand('/home/dev/app', [
      '/home/kai/projects/.pi-agent',
      "/home/kai/agent's tree",
    ]);
    expect(command).toContain(
      `for pi_ps_root in '/home/kai/projects/.pi-agent' '/home/kai/agent'\\''s tree' "$HOME/.pi/agent" '/home/dev/app'/.pi; do`,
    );
  });

  it('scans the npm extension tree pi install uses, package by package', () => {
    const command = piSlashProbeCommand('/home/dev/app');
    expect(command).toContain(
      'for pi_ps_dir in "$pi_ps_root/extensions" "$pi_ps_root/packages" "$pi_ps_root"/npm/node_modules/* "$pi_ps_root"/npm/node_modules/@*/*; do',
    );
  });
});

describe('discoverPiCommands', () => {
  it('returns the probe lines with no error', async () => {
    const result = await discoverPiCommands(
      transport('cmd\tnix\t/home/dev/.pi/agent/extensions\n'),
      '/home/dev/app',
    );
    expect(result.error).toBeNull();
    expect(result.commands.map((command) => command.command)).toEqual(['/nix']);
  });

  it('scans the agent roots it is given', async () => {
    const seen: string[] = [];
    const recording: PiTransport = {
      exec: async (command) => {
        seen.push(command);
        return { stdout: 'cmd\tnix\t/home/kai/projects/.pi-agent/extensions\n', stderr: '', exitCode: 0 };
      },
      sftpRead: async () => '',
    };
    const result = await discoverPiCommands(recording, '/home/dev/app', ['/home/kai/projects/.pi-agent']);
    expect(seen[0]).toContain(`'/home/kai/projects/.pi-agent' "$HOME/.pi/agent"`);
    expect(result.commands.map((command) => command.command)).toEqual(['/nix']);
  });

  it('reports a refused probe', async () => {
    const result = await discoverPiCommands(transport('', 127, 'sh: 1: grep: not found'), '/home/dev/app');
    expect(result.commands).toEqual([]);
    expect(result.error).toBe('sh: 1: grep: not found');
  });

  it('turns a transport fault into an error rather than throwing', async () => {
    const failing: PiTransport = {
      exec: async () => { throw new Error('channel closed'); },
      sftpRead: async () => '',
    };
    const result = await discoverPiCommands(failing, '/home/dev/app');
    expect(result).toEqual({ commands: [], error: 'channel closed' });
  });

  it('accepts output from a probe whose last command reported failure', async () => {
    const result = await discoverPiCommands(
      transport('tpl\treview\t/home/dev/.pi/agent/prompts\n', 1),
      '/home/dev/app',
    );
    expect(result.error).toBeNull();
    expect(result.commands).toHaveLength(1);
  });
});
