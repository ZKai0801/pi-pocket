import { describe, expect, it, vi } from 'vitest';
import { PiRepository, PiRepositoryError, type PiTransport } from '../../src/pi/piRepository';
import { createPiTransport, MAX_SFTP_TRANSFER_BYTES } from '../../src/pi/piTransport';
import {
  readSessionSummariesCommand,
  readSessionSummaryCommand,
  SESSION_SUMMARY_MARKER,
} from '../../src/pi/piCommands';

const ROOT = '/home/projects/.pi-agent/sessions';
const DIR = `${ROOT}/--home-kai--`;

/**
 * A host whose answers are keyed by command, then by `fallback` for anything
 * else (the summary scans, whose exact grouping is not the test's subject).
 * `fail` names commands the transport refuses outright, which is how a dead
 * channel looks to the caller.
 */
function transport(
  handlers: Record<string, string>,
  fail: readonly string[] = [],
  fallback?: (command: string) => string,
): PiTransport {
  return {
    exec: vi.fn(async (command: string) => {
      if (fail.includes(command)) throw new Error('channel closed');
      return { stdout: handlers[command] ?? fallback?.(command) ?? '', stderr: '', exitCode: 0 };
    }),
    sftpRead: vi.fn(async () => ''),
  };
}

/** What the batched summary exec prints for one file: the marker, its path, then the summary text. */
function summaryBlock(path: string, summary: string): string {
  return `${SESSION_SUMMARY_MARKER}${path}\n${summary}`;
}

describe('pi repository', () => {
  it('listProjects: reads cwd from each dir header and de-duplicates', async () => {
    const findDirs = `find '${ROOT}' -mindepth 2 -maxdepth 2 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn`;
    const t = transport({
      // Newest session file first, so the project owning it lists first —
      // the ordering the 项目 tab paints.
      [findDirs]: [
        `1799999999.0 ${DIR}/2026-10-24T10-00-00-000Z_kai.jsonl`,
        `1600000000.0 ${ROOT}/--home-projects-auto_sci--/2026-10-01T00-00-00-000Z_old.jsonl`,
        `1500000000.0 ${ROOT}/--junk--/2020-01-01T00-00-00-000Z_x.jsonl`,
      ].join('\n'),
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

  it('listProjects: a project whose newest session is fresher lists first regardless of name order', async () => {
    const findDirs = `find '${ROOT}' -mindepth 2 -maxdepth 2 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn`;
    const zebra = `${ROOT}/--home-zebra--`;
    const alpha = `${ROOT}/--home-alpha--`;
    const t = transport({
      [findDirs]: [
        `1799999999.0 ${zebra}/new.jsonl`,
        `1600000000.0 ${alpha}/old.jsonl`,
      ].join('\n'),
      [`for f in '${zebra}'/*.jsonl; do head -n 1 "$f"; break; done 2>/dev/null`]:
        '{"type":"session","version":3,"id":"s","cwd":"/home/zebra"}',
      [`for f in '${alpha}'/*.jsonl; do head -n 1 "$f"; break; done 2>/dev/null`]:
        '{"type":"session","version":3,"id":"s","cwd":"/home/alpha"}',
    });
    const projects = await new PiRepository(t, ROOT).listProjects();
    expect(projects.map((project) => project.path)).toEqual(['/home/zebra', '/home/alpha']);
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
    const summary = [
      '{"type":"session","version":3,"id":"01a14cb5","cwd":"/home/kai"}',
      '{"type":"message","id":"u","parentId":"s","timestamp":"2026-10-18T01:52:32.023Z","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1792288352007}}',
      '{"type":"message","id":"a","parentId":"u","timestamp":"2026-10-18T01:52:40.896Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"timestamp":1792288356896}}',
      '{"type":"session_info","id":"n","parentId":"a","timestamp":"2026-10-18T01:52:41.000Z","name":"ninfer-check"}',
    ].join('\n');
    const t = transport({
      [findCmd]: `1792288352.0 ${a}\n`,
      [readSessionSummariesCommand([a], 65536)]: summaryBlock(a, summary),
    });
    expect(await new PiRepository(t, ROOT).listSessions({ path: '/home/kai', name: 'kai' })).toEqual([
      { path: a, id: '01a14cb5-b70d-76f4-b739-6721b8b88c02', name: 'ninfer-check', updatedAtMs: 1792288352000, preview: 'done', turnCount: 2 },
    ]);
  });

  it('listSessions: names a conversation whose /name entry sits above the tail window', async () => {
    // `/name` appends where the user ran it, so a conversation that kept
    // working afterwards carries its name far above the last 64 KiB. The row
    // must still be titled, not fall back to the file's id.
    const findCmd = `find '${DIR}' -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn`;
    const a = `${DIR}/2026-10-20T10-00-00-000Z_01a20000-0000-0000-0000-000000000000.jsonl`;
    const summary = [
      '{"type":"session_info","id":"n","parentId":"s","timestamp":"2026-10-20T10:00:01.000Z","name":"ninfer-check"}',
      '{"type":"message","id":"a2","parentId":"a1","timestamp":"2026-10-20T10:05:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"still here"}],"timestamp":1792288360896}}',
    ].join('\n');
    const t = transport({
      [findCmd]: `1792288352.0 ${a}\n`,
      [readSessionSummariesCommand([a], 65536)]: summaryBlock(a, summary),
    });
    const [row] = await new PiRepository(t, ROOT).listSessions({ path: '/home/kai', name: 'kai' });
    expect(row?.name).toBe('ninfer-check');
    expect(row?.preview).toBe('still here');
  });

  it('listSessions: reads every row in one exec, not one exec per row', async () => {
    // The cost this guards: one SSH round trip per conversation made entering a
    // project with a long history sit there before the list answered.
    const findCmd = `find '${DIR}' -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn`;
    const paths = [
      `${DIR}/2026-10-20T10-00-00-000Z_a.jsonl`,
      `${DIR}/2026-10-19T10-00-00-000Z_b.jsonl`,
      `${DIR}/2026-10-18T10-00-00-000Z_c.jsonl`,
    ];
    const answer = (index: number, text: string): string =>
      `{"type":"message","id":"m","parentId":"s","timestamp":"2026-10-20T10:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}],"timestamp":${1792288352000 + index}}}`;
    const t = transport({
      [findCmd]: paths.map((path, index) => `${1792288352 - index}.0 ${path}`).join('\n'),
      [readSessionSummariesCommand(paths, 65536)]: paths
        .map((path, index) => summaryBlock(path, answer(index, `row ${index}`)))
        .join(''),
    });
    const rows = await new PiRepository(t, ROOT).listSessions({ path: '/home/kai', name: 'kai' });
    expect(rows.map((row) => row.preview)).toEqual(['row 0', 'row 1', 'row 2']);
    // The listing and the summary scan: two round trips for three rows.
    expect(t.exec).toHaveBeenCalledTimes(2);
  });

  it('listSessions: keeps each exec under the output cap, so a long project takes a few batches', async () => {
    // One exec's stdout is capped (1 MiB in the native transport, which fails
    // the whole call past it), so a batch carries only as many files as their
    // tails fit. What must never come back is one round trip per row.
    const findCmd = `find '${DIR}' -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn`;
    const paths = Array.from(
      { length: 9 },
      (_, index) => `${DIR}/2026-10-${`${index + 10}`}T10-00-00-000Z_s${index}.jsonl`,
    );
    const line = (path: string): string =>
      `{"type":"message","id":"m","parentId":"s","timestamp":"2026-10-20T10:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"${path.slice(-14)}"}],"timestamp":1792288352000}}`;
    const t = transport({ [findCmd]: paths.map((path, index) => `${1792288352 - index}.0 ${path}`).join('\n') }, [], (command) => {
      // Answer exactly the files the command names, batched or single.
      const named = [...command.matchAll(/'([^']*\.jsonl)'/gu)].map((match) => match[1] ?? '');
      return named.map((path) => summaryBlock(path, line(path))).join('');
    });
    const rows = await new PiRepository(t, ROOT).listSessions({ path: '/home/kai', name: 'kai' });
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.preview !== null)).toBe(true);
    const execCount = (t.exec as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(execCount).toBeGreaterThan(1);
    expect(execCount).toBeLessThan(paths.length + 1);
  });

  it('listSessions: falls back to one read per row when the summary exec fails', async () => {
    // A dead channel on the batch must cost speed, not the row titles: the
    // row-by-row read still answers, it is just slower.
    const findCmd = `find '${DIR}' -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn`;
    const a = `${DIR}/2026-10-20T10-00-00-000Z_a.jsonl`;
    const b = `${DIR}/2026-10-19T10-00-00-000Z_b.jsonl`;
    const named = (name: string): string =>
      `{"type":"session_info","id":"n","parentId":"s","timestamp":"2026-10-20T10:00:01.000Z","name":"${name}"}`;
    const t = transport(
      {
        [findCmd]: `1792288352.0 ${a}\n1792288351.0 ${b}\n`,
        [readSessionSummaryCommand(a, 65536)]: named('alpha'),
        [readSessionSummaryCommand(b, 65536)]: named('beta'),
      },
      [readSessionSummariesCommand([a, b], 65536)],
    );
    const rows = await new PiRepository(t, ROOT).listSessions({ path: '/home/kai', name: 'kai' });
    expect(rows.map((row) => row.name)).toEqual(['alpha', 'beta']);
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
    // Here the assistant's text sits at the very end of a file that also
    // outruns one transfer, so the read has to page to reach it.
    const filler = 'x'.repeat(1200);
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
    // Bigger than one transfer, so reaching the end cannot be a single read.
    expect(new TextEncoder().encode(content).length).toBeGreaterThan(MAX_SFTP_TRANSFER_BYTES);

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
      { role: 'assistant', text: 'done', timestampMs: 1792288360896, segments: ['done'] },
    ]);
    // The read really paged past the old truncation point.
    expect(calls.length).toBeGreaterThan(1);
    expect(Math.max(...calls.map((call) => Math.floor(call.offset ?? 0))))
      .toBeGreaterThanOrEqual(MAX_SFTP_TRANSFER_BYTES);
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
