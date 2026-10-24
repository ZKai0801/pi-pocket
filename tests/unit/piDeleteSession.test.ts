import { describe, expect, it, vi } from 'vitest';
import {
  PiRepository,
  PiRepositoryError,
  isRemovableSessionFile,
  type PiTransport,
} from '../../src/pi/piRepository';
import { deleteSessionFileCommand } from '../../src/pi/piCommands';

const ROOT = '/home/projects/.pi-agent/sessions';
const DIR = `${ROOT}/--home-kai--`;
const FILE = `${DIR}/2026-10-18T01-52-19-726Z_01a14cb5.jsonl`;

function transport(exitCode: number | null = 0, stderr = ''): PiTransport {
  return {
    exec: vi.fn(async () => ({ stdout: '', stderr, exitCode })),
    sftpRead: vi.fn(async () => ''),
  };
}

describe('pi repository session deletion', () => {
  it('removes the session file with a quoted, option-terminated rm', async () => {
    const t = transport();
    await new PiRepository(t, ROOT).deleteSession(FILE);

    expect(t.exec).toHaveBeenCalledWith(
      deleteSessionFileCommand(FILE),
      expect.any(Number),
    );
    expect(deleteSessionFileCommand(FILE)).toBe(`rm -f -- '${FILE}'`);
  });

  it('throws a typed error when rm fails', async () => {
    const t = transport(1, 'read-only file system');
    await expect(new PiRepository(t, ROOT).deleteSession(FILE)).rejects.toBeInstanceOf(
      PiRepositoryError,
    );
  });

  // The destructive call is driven by a remote listing, so the shape of the
  // path is checked rather than trusted: an odd listing must not become a
  // deleted file somewhere else on the host.
  it('refuses a path outside the session root', async () => {
    const t = transport();
    await expect(
      new PiRepository(t, ROOT).deleteSession('/home/projects/.pi-agent/other/x.jsonl'),
    ).rejects.toBeInstanceOf(PiRepositoryError);
    await expect(new PiRepository(t, ROOT).deleteSession('/etc/passwd')).rejects.toBeInstanceOf(
      PiRepositoryError,
    );
    // No shell command was built for a path that was refused.
    expect(t.exec).not.toHaveBeenCalled();
  });

  it('refuses a path that is not one directory below the root', async () => {
    const t = transport();
    await expect(
      new PiRepository(t, ROOT).deleteSession(`${DIR}/nested/x.jsonl`),
    ).rejects.toBeInstanceOf(PiRepositoryError);
    await expect(new PiRepository(t, ROOT).deleteSession(`${ROOT}/x.jsonl`)).rejects.toBeInstanceOf(
      PiRepositoryError,
    );
    expect(t.exec).not.toHaveBeenCalled();
  });

  it('refuses a traversal and a non-session file', async () => {
    const t = transport();
    await expect(
      new PiRepository(t, ROOT).deleteSession(`${DIR}/../--other--/x.jsonl`),
    ).rejects.toBeInstanceOf(PiRepositoryError);
    await expect(new PiRepository(t, ROOT).deleteSession(`${DIR}/x.txt`)).rejects.toBeInstanceOf(
      PiRepositoryError,
    );
    await expect(new PiRepository(t, ROOT).deleteSession(`${DIR}/.jsonl`)).rejects.toBeInstanceOf(
      PiRepositoryError,
    );
    expect(t.exec).not.toHaveBeenCalled();
  });

  it('accepts a session file one directory below the root', () => {
    expect(isRemovableSessionFile(ROOT, FILE)).toBe(true);
    expect(isRemovableSessionFile(`${ROOT}/`, FILE)).toBe(true);
    expect(isRemovableSessionFile(ROOT, `${DIR}/../--home-kai--/x.jsonl`)).toBe(false);
    expect(isRemovableSessionFile('', FILE)).toBe(false);
    expect(isRemovableSessionFile(ROOT, '')).toBe(false);
  });

  it('keeps quoting the path even when it carries a quote', async () => {
    const nasty = `${DIR}/it's_01.jsonl`;
    const t = transport();
    await new PiRepository(t, ROOT).deleteSession(nasty);

    expect(t.exec).toHaveBeenCalledWith(`rm -f -- '${DIR}/it'\\''s_01.jsonl'`, expect.any(Number));
  });
});
