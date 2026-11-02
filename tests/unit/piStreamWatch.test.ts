import { describe, expect, it, vi } from 'vitest';
import {
  sessionWatchCommand,
  watchSessionFile,
  type PiSessionWatch,
  type PiStreamChunk,
  type PiStreamHandle,
  type PiStreamSource,
} from '../../src/pi/piStream';
import { createPiTurnRunner } from '../../src/pi/piTurnRunner';
import { parsePiSession } from '../../src/pi/parsePiSession';
import { PI_INPUT_READY_MARKER } from '../../src/pi/turnReadiness';
import type { ParsedPiSession } from '../../src/pi/types';
import type { TurnPtyHandle } from '../../src/session/turnPty';

/** A source whose chunks the test drives by hand. */
function fakeSource(options: { handle?: PiStreamHandle | null; fail?: boolean } = {}) {
  let sink: ((chunk: PiStreamChunk) => void) | null = null;
  const closed: string[] = [];
  const source: PiStreamSource & { emit(chunk: PiStreamChunk): void; closed: string[] } = {
    closed,
    emit(chunk: PiStreamChunk) {
      sink?.(chunk);
    },
    async open(_command: string, onChunk: (chunk: PiStreamChunk) => void) {
      if (options.fail) throw new Error('no transport');
      sink = onChunk;
      return options.handle === undefined
        ? { close: async () => undefined }
        : options.handle;
    },
  };
  return source;
}

const header = '{"type":"session","version":3,"id":"s1","timestamp":"2026-10-18T01:52:19.726Z","cwd":"/home/kai"}';
const user =
  '{"type":"message","id":"u1","parentId":"s1","timestamp":"2026-10-18T01:52:32.023Z","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1792288352007}}';
const assistant =
  '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-10-18T01:52:36.042Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"timestamp":1792288359000}}';

describe('sessionWatchCommand', () => {
  it('follows the file from its first line and retries a file that is not there yet', () => {
    // `-F` and not `-f`: a draft's session file does not exist when the turn
    // starts, and a plain `-f` exits on a missing file instead of waiting.
    expect(sessionWatchCommand('/root/a.jsonl')).toBe("tail -F -n +1 -- '/root/a.jsonl'");
  });

  it('quotes a path the shell would otherwise split', () => {
    expect(sessionWatchCommand("/root/it's a dir/a.jsonl")).toBe(
      "tail -F -n +1 -- '/root/it'\\''s a dir/a.jsonl'",
    );
  });
});

describe('watchSessionFile', () => {
  it('accumulates every pushed chunk', async () => {
    const source = fakeSource();
    const watch = (await watchSessionFile(source, '/root/a.jsonl', { coalesceMs: 0 }))!;
    source.emit({ text: header + '\n', done: false });
    source.emit({ text: user + '\n', done: false });
    expect(watch.text()).toBe(`${header}\n${user}\n`);
    watch.close();
  });

  it('wakes a waiter once per burst of appends', async () => {
    const source = fakeSource();
    const watch = (await watchSessionFile(source, '/root/a.jsonl', { coalesceMs: 20 }))!;
    const waits = [watch.waitForChange(2_000), watch.waitForChange(2_000)];
    // Three appends in a row (text, then tool call, then tool result) are one
    // wake: re-parsing the whole file per entry is what the coalescing window
    // exists to avoid.
    source.emit({ text: 'a\n', done: false });
    source.emit({ text: 'b\n', done: false });
    source.emit({ text: 'c\n', done: false });
    await expect(Promise.all(waits)).resolves.toEqual([true, true]);
    // The burst is spent: a further wait has nothing to report.
    await expect(watch.waitForChange(10)).resolves.toBe(false);
    watch.close();
  });

  it('reports a closed watch as one that will never change again', async () => {
    const source = fakeSource();
    const watch = (await watchSessionFile(source, '/root/a.jsonl', { coalesceMs: 0 }))!;
    source.emit({ text: 'last\n', done: false });
    source.emit({ done: true, exitCode: 0 });
    expect(watch.closed).toBe(true);
    // The final bytes still reach the caller before the watch reports closed.
    expect(watch.text()).toBe('last\n');
    await expect(watch.waitForChange(1_000)).resolves.toBe(false);
  });

  it('is null when the platform cannot stream, so the caller falls back', async () => {
    await expect(watchSessionFile(fakeSource({ handle: null }), '/root/a.jsonl')).resolves.toBeNull();
    await expect(watchSessionFile(fakeSource({ fail: true }), '/root/a.jsonl')).resolves.toBeNull();
  });
});

function fakeHandle(): TurnPtyHandle & { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const listeners = new Set<(chunk: string) => void>();
  return {
    write: vi.fn(),
    onData: vi.fn((callback: (chunk: string) => void) => {
      listeners.add(callback);
      callback(PI_INPUT_READY_MARKER);
      return () => listeners.delete(callback);
    }),
    unsubscribe: vi.fn(),
    close: vi.fn(),
    // This double is never killed, so the death watcher has nothing to hear.
    onClose: vi.fn(() => () => undefined),
  } as unknown as TurnPtyHandle & { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

describe('createPiTurnRunner with a follow', () => {
  it('answers a turn from pushed bytes and never re-reads the file', async () => {
    const handle = fakeHandle();
    // One read, before the line is delivered: the baseline the run's target is
    // counted from. Every later read is what the follow replaces.
    const readSession = vi.fn(async (): Promise<ParsedPiSession> =>
      parsePiSession(`${header}\n${user}\n`),
    );
    let nowMs = 0;
    // A watch that appends the assistant's reply the first time it is waited
    // on: exactly what `tail -F` pushes when pi writes the answer.
    const watch: PiSessionWatch = {
      text: () => `${header}\n${user}\n${assistant}\n`,
      closed: false,
      async waitForChange(_timeoutMs: number) {
        return true;
      },
      close: () => undefined,
    };
    const runner = createPiTurnRunner({
      openPty: async () => handle,
      piCommand: '/opt/bin/pi',
      projectPath: '/home/kai/project',
      readSession,
      watchSession: async () => watch,
      newestSessionFile: async () => '/root/a.jsonl',
      sleep: async (ms: number) => {
        nowMs += ms;
      },
      now: () => nowMs,
      readyTimeoutMs: 20_000,
      turnTimeoutMs: 120_000,
      pollIntervalMs: 1_000,
      submitDelayMs: 0,
    });

    const result = await runner.send('/root/a.jsonl', 'hi');

    expect(readSession).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
      expect(result.session.turns[1]?.text).toBe('done');
    }
  });

  it('falls back to reading the file when the follow ends mid-run', async () => {
    const handle = fakeHandle();
    let reads = 0;
    // The baseline first (no reply yet), then the file with the reply in it —
    // which is what the read loop, not the follow, has to find.
    const readSession = vi.fn(async (): Promise<ParsedPiSession> => {
      reads += 1;
      const lines = [`${header}\n${user}\n`];
      if (reads > 1) lines.push(`${assistant}\n`, `${assistant.replace('"a1"', '"a2"')}\n`);
      return parsePiSession(lines.join(''));
    });
    // A watch the host closed (a lost channel, a `tail` that died) answers
    // nothing more; the read loop has to finish the turn.
    const watch: PiSessionWatch = {
      text: () => '',
      closed: true,
      async waitForChange() {
        return false;
      },
      close: () => undefined,
    };
    let nowMs = 0;
    const runner = createPiTurnRunner({
      openPty: async () => handle,
      piCommand: '/opt/bin/pi',
      projectPath: '/home/kai/project',
      readSession,
      watchSession: async () => watch,
      newestSessionFile: async () => '/root/a.jsonl',
      sleep: async (ms: number) => {
        nowMs += ms;
      },
      now: () => nowMs,
      readyTimeoutMs: 20_000,
      turnTimeoutMs: 120_000,
      pollIntervalMs: 1_000,
      submitDelayMs: 0,
    });

    const result = await runner.send('/root/a.jsonl', 'hi');

    expect(readSession).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
