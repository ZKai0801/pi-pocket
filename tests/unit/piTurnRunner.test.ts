import { describe, expect, it, vi } from 'vitest';
import { createPiTurnRunner } from '../../src/pi/piTurnRunner';
import { buildPiOpenCommand } from '../../src/pi/piTurn';
import type { ParsedPiSession } from '../../src/pi/types';
import type { TurnPtyHandle } from '../../src/session/turnPty';

interface FakeHandle extends TurnPtyHandle {
  writes: string[];
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
}) {
  const handle = fakeHandle({ autoReady: options.autoReady, writeError: options.writeError });
  const reads = [...options.reads];
  const openPty = vi.fn(async (_command: string, _geometry: { cols: number; rows: number }) => handle);
  const readSession = vi.fn(async (_path: string) => {
    if (options.neverSettles) return new Promise<ParsedPiSession>(() => {});
    const next = reads.length > 1 ? reads.shift()! : reads[0]!;
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
    sleep,
    now: () => nowMs,
    readyTimeoutMs: 20_000,
    turnTimeoutMs: 120_000,
    pollIntervalMs: 1_000,
    submitDelayMs: 0,
  });
  return { handle, openPty, reads, readSession, runner };
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
});
