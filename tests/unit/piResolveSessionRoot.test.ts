import { describe, expect, it, vi } from 'vitest';
import { resolveSessionRoot } from '../../src/pi/resolveSessionRoot';
import type { PiTransport } from '../../src/pi/piRepository';

function exec(results: Record<string, string>) {
  return { exec: vi.fn(async (c: string) => ({ stdout: results[c] ?? '', stderr: '', exitCode: results[c] === undefined ? 1 : 0 })), sftpRead: vi.fn() };
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
});
