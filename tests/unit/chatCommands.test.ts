import { describe, expect, it, vi } from 'vitest';
import { createChatCommandCatalog } from '../../src/session/chatCommands';
import {
  PI_BUILTIN_COMMANDS,
  parsePiSlashProbe,
  type PiCommandDiscovery,
} from '../../src/pi/piSlashCommands';

function discovery(stdout: string): PiCommandDiscovery {
  return { commands: parsePiSlashProbe(stdout), error: null };
}

describe('chat command catalog', () => {
  it('starts with the built-ins so the sheet is never empty', () => {
    const catalog = createChatCommandCatalog({
      projectPath: () => '/home/dev/app',
      discover: async () => discovery(''),
    });

    expect(catalog.state).toBe('idle');
    expect(catalog.commands.map((command) => command.command))
      .toEqual(PI_BUILTIN_COMMANDS.map((command) => command.command));
  });

  it('merges the host commands once per project', async () => {
    const discover = vi.fn(async () => discovery('cmd\tnix\t/home/dev/.pi/agent/extensions\n'));
    const catalog = createChatCommandCatalog({ projectPath: () => '/home/dev/app', discover });

    await catalog.load();
    expect(catalog.state).toBe('ready');
    expect(catalog.commands.map((command) => command.command)).toContain('/nix');

    await catalog.load();
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('probes again for another project', async () => {
    let project = '/home/dev/app';
    const discover = vi.fn(async () => discovery(''));
    const catalog = createChatCommandCatalog({ projectPath: () => project, discover });

    await catalog.load();
    project = '/home/dev/other';
    await catalog.load();

    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenLastCalledWith('/home/dev/other');
  });

  it('joins an in-flight probe instead of starting a second one', async () => {
    let release: (value: PiCommandDiscovery) => void = () => undefined;
    const pending = new Promise<PiCommandDiscovery>((resolve) => { release = resolve; });
    const discover = vi.fn(() => pending);
    const catalog = createChatCommandCatalog({ projectPath: () => '/home/dev/app', discover });

    const first = catalog.load();
    const second = catalog.load();
    expect(discover).toHaveBeenCalledTimes(1);

    release(discovery('cmd\tnix\t/home/dev/.pi/agent/extensions\n'));
    await Promise.all([first, second]);
    expect(catalog.state).toBe('ready');
  });

  it('keeps the built-ins and flags the failure when the host refuses', async () => {
    const catalog = createChatCommandCatalog({
      projectPath: () => '/home/dev/app',
      discover: async () => ({ commands: [], error: 'channel closed' }),
    });

    await catalog.load();

    expect(catalog.state).toBe('error');
    expect(catalog.commands).toHaveLength(PI_BUILTIN_COMMANDS.length);
  });

  it('flags a rejection too, and a later open retries it', async () => {
    let fail = true;
    const discover = vi.fn(async (): Promise<PiCommandDiscovery> => {
      if (fail) throw new Error('no live connection');
      return discovery('cmd\tnix\t/home/dev/.pi/agent/extensions\n');
    });
    const catalog = createChatCommandCatalog({ projectPath: () => '/home/dev/app', discover });

    await catalog.load();
    expect(catalog.state).toBe('error');

    // A plain load retries an errored project rather than caching the failure.
    fail = false;
    await catalog.load();
    expect(catalog.state).toBe('ready');
    expect(catalog.commands.map((command) => command.command)).toContain('/nix');
  });

  it('drops an answer that lands after the chat moved to another project', async () => {
    let project = '/home/dev/app';
    let release: (value: PiCommandDiscovery) => void = () => undefined;
    const pending = new Promise<PiCommandDiscovery>((resolve) => { release = resolve; });
    const catalog = createChatCommandCatalog({
      projectPath: () => project,
      discover: () => pending,
    });

    const run = catalog.load();
    project = '/home/dev/other';
    release(discovery('cmd\tnix\t/home/dev/.pi/agent/extensions\n'));
    await run;

    expect(catalog.commands.map((command) => command.command)).not.toContain('/nix');
    expect(catalog.state).not.toBe('ready');
  });
});
