import { describe, expect, it, vi } from 'vitest';
import { PiRepository, PiRepositoryError, type PiTransport } from '../../src/pi/piRepository';
import { createPiTransport } from '../../src/pi/piTransport';

const ROOT = '/home/projects/.pi-agent/sessions';
const DIR = `${ROOT}/--home-kai--`;

function transport(handlers: Record<string, string>): PiTransport {
  return {
    exec: vi.fn(async (command: string) => ({ stdout: handlers[command] ?? '', stderr: '', exitCode: 0 })),
    sftpRead: vi.fn(async () => ''),
  };
}

describe('pi repository', () => {
  it('listProjects: reads cwd from each dir header and de-duplicates', async () => {
    const t = transport({
      "ls -1 -- '/home/projects/.pi-agent/sessions' 2>/dev/null": '--home-kai--\n--junk--\n--home-projects-auto_sci--',
      [`for f in '${DIR}'/*.jsonl; do head -n 1 "$f"; break; done 2>/dev/null`]:
        '{"type":"session","version":3,"id":"s","cwd":"/home/kai"}',
      [`for f in '${ROOT}/--junk--'/*.jsonl; do head -n 1 "$f"; break; done 2>/dev/null`]: '',
      "for f in '/home/projects/.pi-agent/sessions/--home-projects-auto_sci--'/*.jsonl; do head -n 1 \"$f\"; break; done 2>/dev/null":
        '{"type":"session","version":3,"id":"s","cwd":"/home/projects/auto_sci"}',
    });
    expect(await new PiRepository(t, ROOT).listProjects()).toEqual([
      { path: '/home/kai', name: 'kai' },
      { path: '/home/projects/auto_sci', name: 'auto_sci' },
    ]);
  });

  it('listProjects: returns [] when the root has no dirs', async () => {
    expect(await new PiRepository(transport({}), ROOT).listProjects()).toEqual([]);
  });

  it('listProjects: throws a typed error when the listing command fails', async () => {
    const t: PiTransport = { exec: vi.fn(async () => ({ stdout: '', stderr: 'no such dir', exitCode: 2 })), sftpRead: vi.fn() };
    await expect(new PiRepository(t, ROOT).listProjects()).rejects.toBeInstanceOf(PiRepositoryError);
  });

  it('listSessions: maps find output to session metadata, newest first', async () => {
    const findCmd = `find '${DIR}' -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn`;
    const a = `${DIR}/2026-10-18T01-52-19-726Z_01a14cb5-b70d-76f4-b739-6721b8b88c02.jsonl`;
    const t = transport({
      [findCmd]: `1792288352.0 ${a}\n`,
      [`tail -c 65536 -- '${a}' 2>/dev/null`]: [
        '{"type":"session","version":3,"id":"01a14cb5","cwd":"/home/kai"}',
        '{"type":"message","id":"u","parentId":"s","timestamp":"2026-10-18T01:52:32.023Z","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1792288352007}}',
        '{"type":"message","id":"a","parentId":"u","timestamp":"2026-10-18T01:52:40.896Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"timestamp":1792288356896}}',
        '{"type":"session_info","id":"n","parentId":"a","timestamp":"2026-10-18T01:52:41.000Z","name":"ninfer-check"}',
      ].join('\n'),
    });
    expect(await new PiRepository(t, ROOT).listSessions({ path: '/home/kai', name: 'kai' })).toEqual([
      { path: a, id: '01a14cb5-b70d-76f4-b739-6721b8b88c02', name: 'ninfer-check', updatedAtMs: 1792288352000, preview: 'done', turnCount: 2 },
    ]);
  });

  it('readSession: prefers SFTP and falls back to tail on failure', async () => {
    const t = transport({});
    t.sftpRead = vi.fn(async () => { throw new Error('too big'); });
    const parsed = await new PiRepository(t, ROOT).readSession(`${DIR}/x.jsonl`);
    expect(parsed.turns).toEqual([]);
    expect(t.exec).toHaveBeenCalled();
  });

  it('readSession: reads a file past the old 256 KiB head truncation', async () => {
    // The regression this guards: a head-anchored single read stopped at
    // 256 KiB, and in a tool-heavy session everything past it is dropped
    // tool records — so the chat showed only the user's own messages.
    // Here the assistant's text sits at the very end of a ~430 KiB file.
    const filler = 'x'.repeat(700);
    const lines = [
      '{"type":"session","version":3,"id":"01a1534c","cwd":"/home/kai"}',
      '{"type":"message","id":"u","parentId":"s","timestamp":"2026-10-18T01:52:32.023Z","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1792288352007}}',
      ...Array.from(
        { length: 500 },
        (_, index) =>
          `{"type":"message","id":"t${index}","parentId":"u","timestamp":"2026-10-18T01:53:00.000Z","message":{"role":"toolResult","content":[{"type":"text","text":"${filler}"}]}}`,
      ),
      '{"type":"message","id":"a","parentId":"u","timestamp":"2026-10-18T01:54:40.896Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"timestamp":1792288360896}}',
    ];
    const content = `${lines.join('\n')}\n`;
    expect(new TextEncoder().encode(content).length).toBeGreaterThan(256 * 1024);

    const bytes = new TextEncoder().encode(content);
    const calls: Array<{ path: string; maxBytes: number; offset?: number }> = [];
    const sftp = {
      sftpRead: async (options: { path: string; maxBytes: number; offset?: number }) => {
        calls.push(options);
        const start = Math.floor(options.offset ?? 0);
        return { dataBase64: Buffer.from(bytes.subarray(start, start + options.maxBytes)).toString('base64') };
      },
    };
    const t: PiTransport = createPiTransport({ exec: vi.fn() }, sftp);

    const parsed = await new PiRepository(t, ROOT).readSession(`${DIR}/big.jsonl`);
    expect(parsed.turns).toEqual([
      { role: 'user', text: 'hi', timestampMs: 1792288352007 },
      { role: 'assistant', text: 'done', timestampMs: 1792288360896 },
    ]);
    // The read really paged past the old truncation point.
    expect(calls.length).toBeGreaterThan(1);
    expect(Math.max(...calls.map((call) => Math.floor(call.offset ?? 0)))).toBeGreaterThanOrEqual(256 * 1024);
  });

  it('readSession: the exec fallback pages by lines, not bytes', async () => {
    const path = `${DIR}/x.jsonl`;
    const firstPageCommand = `tail -n +1 -- '${path}' 2>/dev/null | head -n 4096`;
    const secondPageCommand = `tail -n +4097 -- '${path}' 2>/dev/null | head -n 4096`;
    const pages: Record<string, string> = {
      [firstPageCommand]: `${Array.from({ length: 4096 }, (_, index) => `{"n":${index}}`).join('\n')}\n`,
      [secondPageCommand]: '{"n":4096}\n{"n":4097}',
    };
    const commands: string[] = [];
    const t: PiTransport = {
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        return { stdout: pages[command] ?? '', stderr: '', exitCode: 0 };
      }),
      sftpRead: vi.fn(async () => { throw new Error('sftp unavailable'); }),
    };
    await new PiRepository(t, ROOT).readSession(path);
    expect(commands).toEqual([firstPageCommand, secondPageCommand]);
  });
});
