import { describe, expect, it, vi } from 'vitest';
import { resolveSessionRoot } from '../../src/pi/resolveSessionRoot';
import { sessionsRootHasFilesCommand } from '../../src/pi/piCommands';
import type { PiTransport } from '../../src/pi/piRepository';

function exec(results: Record<string, string>) {
  return { exec: vi.fn(async (c: string) => ({ stdout: results[c] ?? '', stderr: '', exitCode: results[c] === undefined ? 1 : 0 })), sftpRead: vi.fn() };
}

/** The depth-2 jsonl shape probe, as the resolver's first pass sends it. */
function shaped(root: string): string {
  return sessionsRootHasFilesCommand(root);
}

describe('resolveSessionRoot', () => {
  it('returns the override when it exists as a directory', async () => {
    const t = exec({ "test -d '/srv/pi/sessions' && echo yes": 'yes\n' });
    expect(await resolveSessionRoot(t as unknown as PiTransport, '/home/kai', {}, '/srv/pi/sessions'))
      .toBe('/srv/pi/sessions');
  });

  it('falls through to the next candidate when one is missing', async () => {
    const t = exec({ "test -d '/home/kai/.pi-agent/sessions' && echo yes": 'yes\n' });
    expect(await resolveSessionRoot(t as unknown as PiTransport, '/home/kai', {}))
      .toBe('/home/kai/.pi-agent/sessions');
  });

  it('does not accept a file in place of a directory', async () => {
    const t = exec({ "test -d '/srv/x' && echo yes": '' });
    expect(await resolveSessionRoot(t as unknown as PiTransport, '/home/kai', {}, '/srv/x'))
      .toBe(null);
  });

  it('returns null when nothing exists', async () => {
    expect(await resolveSessionRoot(exec({}) as unknown as PiTransport, '/home/kai', {})).toBe(null);
  });

  it('skips an existing override that has no session files in it', async () => {
    // The override names the agent tree itself: it exists, but its jsonl files
    // sit at other depths, so pass 1 rejects it and adopts the default root.
    const t = exec({
      "test -d '/home/kai/projects/.pi-agent' && echo yes": 'yes\n',
      [shaped('/home/kai/.pi/agent/sessions')]: 'yes\n',
    });
    expect(await resolveSessionRoot(t as unknown as PiTransport, '/home/kai', {}, '/home/kai/projects/.pi-agent'))
      .toBe('/home/kai/.pi/agent/sessions');
  });

  it('prefers a shaped candidate over an earlier bare directory', async () => {
    const t = exec({
      "test -d '/home/kai/.pi-agent/sessions' && echo yes": 'yes\n',
      [shaped('/home/kai/.pi/agent/sessions')]: 'yes\n',
    });
    expect(await resolveSessionRoot(t as unknown as PiTransport, '/home/kai', {}))
      .toBe('/home/kai/.pi/agent/sessions');
  });
});

describe('sessionsRootHasFilesCommand', () => {
  it('looks for jsonl exactly one encoded directory below the root', () => {
    expect(sessionsRootHasFilesCommand('/home/kai/.pi/agent/sessions'))
      .toBe("find '/home/kai/.pi/agent/sessions' -mindepth 2 -maxdepth 2 -name '*.jsonl' -print -quit 2>/dev/null | grep -q . && echo yes");
  });
});
