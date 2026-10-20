import { describe, expect, it, vi } from 'vitest';
import {
  createPiTurnRunner,
  SESSION_ALREADY_OPEN_ERROR,
} from '../../src/pi/piTurnRunner';
import { buildPiOpenCommand } from '../../src/pi/piTurn';
import type { ParsedPiSession } from '../../src/pi/types';
import type { TurnPtyHandle } from '../../src/session/turnPty';

interface FakeHandle extends TurnPtyHandle {
  writes: string[];
  write: ReturnType<typeof vi.fn>;
  emit(chunk: string): void;
  unsubscribe: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function sessionWithAssistantTurns(assistantTurns: number): ParsedPiSession {
  const turns: ParsedPiSession['turns'] = [{ role: 'user', text: 'hi', timestampMs: 1 }];
  for (let index = 0; index < assistantTurns; index += 1) {
    turns.push({ role: 'assistant', text: `reply ${index}`, timestampMs: 2 + index });
  }
  return { version: 3, id: 'a', cwd: '/home/kai/project', name: null, turns };
}

function fakeHandle(options: { autoReady?: boolean; writeError?: Error } = {}): FakeHandle {
  const listeners = new Set<(chunk: string) => void>();
  const writes: string[] = [];
  const unsubscribe = vi.fn((callback: (chunk: string) => void) => {
    listeners.delete(callback);
  });
  const close = vi.fn();
  return {
    writes,
    write: vi.fn((data: string) => {
      if (options.writeError) throw options.writeError;
      writes.push(data);
    }),
    onData: vi.fn((callback: (chunk: string) => void) => {
      listeners.add(callback);
      if (options.autoReady) callback('\u203a ');
      return () => unsubscribe(callback);
    }),
    close,
    unsubscribe,
    emit(chunk: string) {
      for (const listener of [...listeners]) listener(chunk);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function harness(options: {
  autoReady?: boolean;
  writeError?: Error;
  reads: Array<ParsedPiSession | Error>;
  neverSettles?: boolean;
  newest?: Array<string | null | Error>;
  turnTimeoutMs?: number;
}) {
  const handle = fakeHandle({ autoReady: options.autoReady, writeError: options.writeError });
  const reads = [...options.reads];
  const newest = [...(options.newest ?? [null])];
  const openPty = vi.fn(async (_command: string, _geometry: { cols: number; rows: number }) => handle);
  const readSession = vi.fn(async (_path: string) => {
    if (options.neverSettles) return new Promise<ParsedPiSession>(() => {});
    const next = reads.length > 1 ? reads.shift()! : reads[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  const newestSessionFile = vi.fn(async (_projectPath: string) => {
    const next = newest.length > 1 ? newest.shift()! : newest[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  let nowMs = 0;
  const sleep = vi.fn(async (ms: number) => {
    nowMs += ms;
  });
  const runner = createPiTurnRunner({
    openPty,
    piCommand: '/opt/bin/pi',
    projectPath: '/home/kai/project',
    readSession,
    newestSessionFile,
    sleep,
    now: () => nowMs,
    readyTimeoutMs: 20_000,
    turnTimeoutMs: options.turnTimeoutMs ?? 120_000,
    pollIntervalMs: 1_000,
    submitDelayMs: 0,
  });
  return { handle, openPty, reads, readSession, newestSessionFile, runner };
}

describe('createPiTurnRunner', () => {
  it('opens with the built command, delivers the line and CR, then returns the polled session', async () => {
    const completed = sessionWithAssistantTurns(1);
    const h = harness({ autoReady: true, reads: [sessionWithAssistantTurns(0), completed] });

    const result = await h.runner.send('/r/a.jsonl', 'hi');

    expect(h.openPty).toHaveBeenCalledTimes(1);
    expect(h.openPty).toHaveBeenCalledWith(
      buildPiOpenCommand('/opt/bin/pi', '/home/kai/project', '/r/a.jsonl'),
      { cols: 80, rows: 24 },
    );
    expect(h.handle.writes).toEqual(['hi', '\r']);
    expect(h.readSession).toHaveBeenCalledWith('/r/a.jsonl');
    expect(result).toEqual({ ok: true, session: completed });
    expect(h.runner.isBusy()).toBe(false);
    expect(h.handle.unsubscribe).toHaveBeenCalled();
  });

  it('refuses a second send while a turn is in flight', async () => {
    const h = harness({
      autoReady: false,
      reads: [sessionWithAssistantTurns(0), sessionWithAssistantTurns(1)],
    });

    const first = h.runner.send('/r/a.jsonl', 'one');
    const second = await h.runner.send('/r/a.jsonl', 'two');

    expect(second).toEqual({ ok: false, error: expect.stringMatching(/running/i) });
    await flushMicrotasks();
    h.handle.emit('\u203a ');
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(h.runner.isBusy()).toBe(false);
  });

  it('reports a failed write without polling and clears busy', async () => {
    const h = harness({
      autoReady: true,
      writeError: new Error('pty closed'),
      reads: [sessionWithAssistantTurns(0)],
    });

    const result = await h.runner.send('/r/a.jsonl', 'hi');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('pty closed');
    expect(h.readSession).toHaveBeenCalledTimes(1);
    expect(h.handle.writes).toEqual([]);
    expect(h.runner.isBusy()).toBe(false);
  });

  it('fails with a readiness error when the PTY never prints a prompt', async () => {
    const h = harness({ autoReady: false, reads: [sessionWithAssistantTurns(0)] });

    const result = await h.runner.send('/r/a.jsonl', 'hi');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/ready/i);
    expect(h.readSession).not.toHaveBeenCalled();
    expect(h.runner.isBusy()).toBe(false);
  });

  it('times out when a poll never sees a new assistant turn', async () => {
    const h = harness({ autoReady: true, reads: [sessionWithAssistantTurns(0)] });

    const result = await h.runner.send('/r/a.jsonl', 'hi');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/timed out/i);
    expect(h.readSession.mock.calls.length).toBeGreaterThan(1);
    expect(h.runner.isBusy()).toBe(false);
  });

  it('times out when a session read never settles', async () => {
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0)],
      neverSettles: true,
    });

    const result = await h.runner.send('/r/a.jsonl', 'hi');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/timed out/i);
    expect(h.runner.isBusy()).toBe(false);
    expect(h.handle.unsubscribe).toHaveBeenCalled();
  });

  it('refuses an empty message without opening a PTY', async () => {
    const h = harness({ autoReady: true, reads: [sessionWithAssistantTurns(0)] });

    const result = await h.runner.send('/r/a.jsonl', ' \n\t ');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/empty/i);
    expect(h.openPty).not.toHaveBeenCalled();
    expect(h.readSession).not.toHaveBeenCalled();
    expect(h.runner.isBusy()).toBe(false);
  });

  it('retries a failed session read and returns once the assistant turn appears', async () => {
    const completed = sessionWithAssistantTurns(1);
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), new Error('transient'), completed],
    });

    const result = await h.runner.send('/r/a.jsonl', 'hi');

    expect(result).toEqual({ ok: true, session: completed });
    expect(h.readSession).toHaveBeenCalledTimes(3);
  });

  it('reuses the same handle for a later send after the first turn completes', async () => {
    const firstCompleted = sessionWithAssistantTurns(1);
    const h = harness({ autoReady: true, reads: [sessionWithAssistantTurns(0), firstCompleted] });

    await expect(h.runner.send('/r/a.jsonl', 'one')).resolves.toMatchObject({ ok: true });
    h.reads.push(sessionWithAssistantTurns(2));
    await expect(h.runner.send('/r/a.jsonl', 'two')).resolves.toMatchObject({ ok: true });

    expect(h.openPty).toHaveBeenCalledTimes(1);
    expect(h.handle.writes).toEqual(['one', '\r', 'two', '\r']);
  });

  it('dispose closes the handle, unsubscribes and refuses later sends', async () => {
    const h = harness({ autoReady: false, reads: [sessionWithAssistantTurns(0)] });

    const pending = h.runner.send('/r/a.jsonl', 'hi');
    await flushMicrotasks();
    h.runner.dispose();

    await expect(pending).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/disposed/i),
    });
    expect(h.handle.close).toHaveBeenCalledTimes(1);
    expect(h.handle.unsubscribe).toHaveBeenCalled();
    expect(h.runner.isBusy()).toBe(false);

    await expect(h.runner.send('/r/a.jsonl', 'again')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/disposed/i),
    });
    expect(h.openPty).toHaveBeenCalledTimes(1);
  });

  it('startNew opens a sessionless command, adopts the newest file and returns its first assistant turn', async () => {
    const completed = sessionWithAssistantTurns(1);
    const h = harness({
      autoReady: true,
      newest: ['/r/old.jsonl', '/r/new.jsonl'],
      reads: [sessionWithAssistantTurns(0), completed],
    });

    const result = await h.runner.startNew('/home/kai/other', 'hi');

    expect(h.openPty).toHaveBeenCalledTimes(1);
    expect(h.openPty).toHaveBeenCalledWith(
      buildPiOpenCommand('/opt/bin/pi', '/home/kai/other'),
      { cols: 80, rows: 24 },
    );
    expect(h.newestSessionFile).toHaveBeenCalledWith('/home/kai/other');
    expect(h.handle.writes).toEqual(['hi', '\r']);
    // The baseline list is read before the first byte is delivered.
    expect(h.newestSessionFile.mock.invocationCallOrder[0]).toBeLessThan(
      h.handle.write.mock.invocationCallOrder[0]!,
    );
    expect(h.readSession).toHaveBeenCalledWith('/r/new.jsonl');
    expect(result).toEqual({
      ok: true,
      sessionFile: '/r/new.jsonl',
      session: completed,
    });
    expect(h.runner.isBusy()).toBe(false);
    expect(h.handle.unsubscribe).toHaveBeenCalled();
  });

  it('startNew adopts the first file when the project had no sessions before', async () => {
    const completed = sessionWithAssistantTurns(1);
    const h = harness({
      autoReady: true,
      newest: [null, '/r/first.jsonl'],
      reads: [sessionWithAssistantTurns(0), completed],
    });

    await expect(h.runner.startNew('/home/kai/project', 'hi')).resolves.toEqual({
      ok: true,
      sessionFile: '/r/first.jsonl',
      session: completed,
    });
  });

  it('startNew times out when no new session file appears', async () => {
    const h = harness({
      autoReady: true,
      newest: ['/r/old.jsonl'],
      reads: [sessionWithAssistantTurns(0)],
    });

    const result = await h.runner.startNew('/home/kai/project', 'hi');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/new session file/i);
    expect(result.ok === false && result.error).toMatch(/timeout|timed out/i);
    expect(h.newestSessionFile.mock.calls.length).toBeGreaterThan(1);
    expect(h.readSession).not.toHaveBeenCalled();
    expect(h.runner.isBusy()).toBe(false);
    expect(h.handle.unsubscribe).toHaveBeenCalled();
  });

  it('startNew times out when the adopted file never gains an assistant turn', async () => {
    const h = harness({
      autoReady: true,
      newest: ['/r/old.jsonl', '/r/old.jsonl', '/r/new.jsonl'],
      reads: [sessionWithAssistantTurns(0)],
      turnTimeoutMs: 3_000,
    });

    const result = await h.runner.startNew('/home/kai/project', 'hi');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/timed out/i);
    expect(result.ok === false && result.error).not.toMatch(/new session file/i);
    expect(h.readSession).toHaveBeenCalledWith('/r/new.jsonl');
    expect(h.readSession.mock.calls.length).toBeGreaterThan(1);
    expect(h.runner.isBusy()).toBe(false);
  });

  it('startNew gives the assistant poll the same deadline as the file poll', async () => {
    const h = harness({
      autoReady: true,
      newest: ['/r/old.jsonl', '/r/old.jsonl', '/r/new.jsonl'],
      reads: [sessionWithAssistantTurns(0), sessionWithAssistantTurns(1)],
      turnTimeoutMs: 2_000,
    });

    // The file is adopted at 1s; the assistant reply would arrive on the next
    // 1s poll, exactly at the turn's 2s deadline. A fresh budget would return
    // this reply after 2s, so only a shared deadline times out here.
    const result = await h.runner.startNew('/home/kai/project', 'hi');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/timed out/i);
    expect(h.readSession).toHaveBeenCalledTimes(2);
    expect(h.runner.isBusy()).toBe(false);
  });

  it('startNew refuses to reuse a runner already attached to a session', async () => {
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), sessionWithAssistantTurns(1)],
    });

    await expect(h.runner.send('/r/a.jsonl', 'hi')).resolves.toMatchObject({ ok: true });
    const result = await h.runner.startNew('/home/kai/project', 'new');

    expect(result).toEqual({ ok: false, error: SESSION_ALREADY_OPEN_ERROR });
    expect(h.openPty).toHaveBeenCalledTimes(1);
    expect(h.newestSessionFile).not.toHaveBeenCalled();
    expect(h.runner.isBusy()).toBe(false);
  });

  it('startNew refuses an empty message without opening a PTY', async () => {
    const h = harness({ autoReady: true, reads: [sessionWithAssistantTurns(0)] });

    const result = await h.runner.startNew('/home/kai/project', ' \n\t ');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/empty/i);
    expect(h.openPty).not.toHaveBeenCalled();
    expect(h.newestSessionFile).not.toHaveBeenCalled();
    expect(h.readSession).not.toHaveBeenCalled();
    expect(h.runner.isBusy()).toBe(false);
  });

  it('startNew refuses a second turn while one is in flight', async () => {
    const h = harness({
      autoReady: false,
      newest: ['/r/old.jsonl', '/r/new.jsonl'],
      reads: [sessionWithAssistantTurns(0), sessionWithAssistantTurns(1)],
    });

    const first = h.runner.startNew('/home/kai/project', 'one');
    const second = await h.runner.startNew('/home/kai/project', 'two');

    expect(second).toEqual({ ok: false, error: expect.stringMatching(/running/i) });
    await flushMicrotasks();
    h.handle.emit('\u203a ');
    await expect(first).resolves.toMatchObject({ ok: true, sessionFile: '/r/new.jsonl' });
    expect(h.openPty).toHaveBeenCalledTimes(1);
    expect(h.runner.isBusy()).toBe(false);
  });

  it('startNew abandons an in-flight draft when the runner is disposed', async () => {
    const h = harness({
      autoReady: false,
      newest: [null, '/r/new.jsonl'],
      reads: [sessionWithAssistantTurns(0)],
    });

    const pending = h.runner.startNew('/home/kai/project', 'hi');
    await flushMicrotasks();
    h.runner.dispose();

    await expect(pending).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/disposed/i),
    });
    expect(h.handle.close).toHaveBeenCalledTimes(1);
    expect(h.handle.unsubscribe).toHaveBeenCalled();
    expect(h.runner.isBusy()).toBe(false);
  });
});
