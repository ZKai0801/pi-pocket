import { describe, expect, it, vi } from 'vitest';
import {
  createPiTurnRunner,
  SESSION_ALREADY_OPEN_ERROR,
} from '../../src/pi/piTurnRunner';
import { buildPiOpenCommand, PI_TURN_CREATED_MARKER, turnSessionName } from '../../src/pi/piTurn';
import { PI_INPUT_READY_MARKER } from '../../src/pi/turnReadiness';
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
      if (options.autoReady) callback(PI_INPUT_READY_MARKER);
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(options: {
  autoReady?: boolean;
  writeError?: Error;
  reads: Array<ParsedPiSession | Error | Promise<ParsedPiSession>>;
  neverSettles?: boolean;
  newest?: Array<string | null | Error>;
  turnTimeoutMs?: number;
  /** Give every reopened PTY its own handle, so a restart is visible. */
  freshHandles?: boolean;
}) {
  const handle = fakeHandle({ autoReady: options.autoReady, writeError: options.writeError });
  const handles: FakeHandle[] = [handle];
  let opens = 0;
  const reads = [...options.reads];
  const newest = [...(options.newest ?? [null])];
  const openPty = vi.fn(async (_command: string, _geometry: { cols: number; rows: number }) => {
    opens += 1;
    if (options.freshHandles !== true || opens === 1) return handle;
    const next = fakeHandle({ autoReady: options.autoReady, writeError: options.writeError });
    handles.push(next);
    return next;
  });
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
  const closeSession = vi.fn(async (_sessionName: string) => undefined);
  const rememberTurn = vi.fn(
    (_turn: { sessionName: string; sessionFile: string; target: number }) => undefined,
  );
  const forgetTurn = vi.fn((_sessionName: string) => undefined);
  const runner = createPiTurnRunner({
    openPty,
    piCommand: '/opt/bin/pi',
    projectPath: '/home/kai/project',
    readSession,
    newestSessionFile,
    closeSession,
    rememberTurn,
    forgetTurn,
    sleep,
    now: () => nowMs,
    readyTimeoutMs: 20_000,
    turnTimeoutMs: options.turnTimeoutMs ?? 120_000,
    pollIntervalMs: 1_000,
    submitDelayMs: 0,
  });
  return {
    handle,
    // Every PTY this runner opened, in order: a restart is only visible by
    // looking at the handle the second open produced.
    handles,
    openPty,
    reads,
    readSession,
    newestSessionFile,
    runner,
    closeSession,
    rememberTurn,
    forgetTurn,
  };
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
    h.handle.emit(PI_INPUT_READY_MARKER);
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

  it('waits for Pi itself when the session had to be created', async () => {
    const h = harness({ autoReady: false, reads: [sessionWithAssistantTurns(0)] });

    const pending = h.runner.send('/r/a.jsonl', 'hi');
    await flushMicrotasks();
    // A new session announces itself, then Pi has to mount its editor before
    // a line can be taken.
    h.handle.emit(`\n${PI_TURN_CREATED_MARKER}\n`);

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/ready/i);
  });

  it('treats a re-attached session as ready on its repaint alone', async () => {
    const h = harness({
      autoReady: false,
      reads: [sessionWithAssistantTurns(0), sessionWithAssistantTurns(1)],
    });

    const pending = h.runner.send('/r/a.jsonl', 'hi');
    await flushMicrotasks();
    // tmux repainting a live pane: the editor is already mounted, so the
    // bracketed-paste handshake never comes back and must not be waited for.
    h.handle.emit('\u001b[2J\u001b[Hpi editor\r\n');

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(h.handle.writes).toEqual(['hi', '\r']);
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
    // A draft's tmux name is unique per attempt, so match the shape rather
    // than one recomputable string.
    expect(h.openPty).toHaveBeenCalledWith(
      expect.stringMatching(
        /^if command -v tmux [^\n]*new-session -d -s 'ps-pi-draft-[a-z0-9]+-[a-z0-9]+' /,
      ),
      { cols: 80, rows: 24 },
    );
    expect(h.openPty.mock.calls[0]?.[0]).toContain(`exec '/opt/bin/pi'`);
    expect(h.openPty.mock.calls[0]?.[0]).not.toContain('--session');
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
    h.handle.emit(PI_INPUT_READY_MARKER);
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
  it('delivers a command and returns without polling for a reply', async () => {
    const h = harness({ autoReady: true, reads: [sessionWithAssistantTurns(0)] });

    const result = await h.runner.runCommand('/r/a.jsonl', '/compact keep the API notes');

    expect(result).toEqual({ ok: true, hiddenUi: false });
    expect(h.handle.writes).toEqual(['/compact keep the API notes', '\r']);
    // The command writes no assistant turn, so waiting for one is the 120 s
    // timeout this channel exists to avoid.
    expect(h.readSession).not.toHaveBeenCalled();
    expect(h.runner.isBusy()).toBe(false);
  });

  it('reuses the PTY for an in-place command, so the next message follows it', async () => {
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), sessionWithAssistantTurns(1)],
    });

    await h.runner.runCommand('/r/a.jsonl', '/compact');
    await expect(h.runner.send('/r/a.jsonl', 'hi')).resolves.toMatchObject({ ok: true });

    expect(h.openPty).toHaveBeenCalledTimes(1);
    expect(h.handle.writes).toEqual(['/compact', '\r', 'hi', '\r']);
  });

  it('drops a terminal-owning command\'s PTY before the next line, not during it', async () => {
    const h = harness({
      autoReady: true,
      freshHandles: true,
      reads: [sessionWithAssistantTurns(0), sessionWithAssistantTurns(1)],
    });

    const result = await h.runner.runCommand('/r/a.jsonl', '/tree');

    expect(result).toEqual({ ok: true, hiddenUi: true });
    // The command may still be running: killing its PTY now would abort it.
    expect(h.handle.close).not.toHaveBeenCalled();

    await expect(h.runner.send('/r/a.jsonl', 'hi')).resolves.toMatchObject({ ok: true });

    // A picker left open would have eaten this message; the reopened PTY is
    // attached to the chat's own session file instead.
    expect(h.handle.close).toHaveBeenCalledTimes(1);
    expect(h.openPty).toHaveBeenCalledTimes(2);
    expect(h.openPty).toHaveBeenLastCalledWith(
      buildPiOpenCommand('/opt/bin/pi', '/home/kai/project', '/r/a.jsonl'),
      { cols: 80, rows: 24 },
    );
    expect(h.handles[1]?.writes).toEqual(['hi', '\r']);
  });

  it('runs a draft command on the sessionless PTY and adopts nothing', async () => {
    const h = harness({ autoReady: true, reads: [sessionWithAssistantTurns(0)] });

    const result = await h.runner.runCommand(null, '/model openai/gpt-5-codex');

    expect(result).toEqual({ ok: true, hiddenUi: false });
    // A draft's tmux name is random, so the open is read by what it runs:
    // pi on the project, with no session file to attach to.
    const opened = h.openPty.mock.calls[0]?.[0] ?? '';
    expect(opened).toContain("cd '/home/kai/project' && exec '/opt/bin/pi'");
    expect(opened).not.toContain('--session');
    expect(h.newestSessionFile).not.toHaveBeenCalled();
    expect(h.handle.writes).toEqual(['/model openai/gpt-5-codex', '\r']);
  });

  it('refuses a line that is not a command without opening a PTY', async () => {
    const h = harness({ autoReady: true, reads: [sessionWithAssistantTurns(0)] });

    const result = await h.runner.runCommand('/r/a.jsonl', 'hello');

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/not a pi command/i) });
    expect(h.openPty).not.toHaveBeenCalled();
    expect(h.runner.isBusy()).toBe(false);
  });

  it('refuses a command while a turn is in flight', async () => {
    const h = harness({
      autoReady: false,
      reads: [sessionWithAssistantTurns(0), sessionWithAssistantTurns(1)],
    });

    const first = h.runner.send('/r/a.jsonl', 'one');
    const second = await h.runner.runCommand('/r/a.jsonl', '/name two');

    expect(second).toEqual({ ok: false, error: expect.stringMatching(/running/i) });
    await flushMicrotasks();
    h.handle.emit('\u203a ');
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it('reports a command delivery failure without leaving the runner busy', async () => {
    const h = harness({
      autoReady: true,
      writeError: new Error('pty closed'),
      reads: [sessionWithAssistantTurns(0)],
    });

    const result = await h.runner.runCommand('/r/a.jsonl', '/compact');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('pty closed');
    expect(h.handle.writes).toEqual([]);
    expect(h.readSession).not.toHaveBeenCalled();
    expect(h.runner.isBusy()).toBe(false);
  });

  it('beginSend resolves once the line is delivered and keeps the reply pending in completed', async () => {
    const reply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), reply.promise],
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'hi');

    expect(begun).toMatchObject({ ok: true, sessionFile: '/r/a.jsonl' });
    if (!begun.ok) return;
    expect(h.handle.writes).toEqual(['hi', '\r']);
    expect(h.runner.isBusy()).toBe(true);

    reply.resolve(sessionWithAssistantTurns(1));
    await expect(begun.completed).resolves.toEqual({
      ok: true,
      session: sessionWithAssistantTurns(1),
    });
    expect(h.runner.isBusy()).toBe(false);
  });

  it('beginSend reports a delivery failure without leaving the runner busy', async () => {
    const h = harness({
      autoReady: true,
      writeError: new Error('pty closed'),
      reads: [sessionWithAssistantTurns(0)],
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'hi');

    expect(begun.ok).toBe(false);
    expect(begun.ok === false && begun.error).toContain('pty closed');
    expect(h.runner.isBusy()).toBe(false);
  });

  it('beginStartNew returns the adopted file before the reply and completes later', async () => {
    const reply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      newest: ['/r/old.jsonl', '/r/new.jsonl'],
      reads: [sessionWithAssistantTurns(0), reply.promise],
    });

    const begun = await h.runner.beginStartNew('/home/kai/project', 'hi');

    expect(begun).toMatchObject({ ok: true, sessionFile: '/r/new.jsonl' });
    if (!begun.ok) return;
    expect(h.handle.writes).toEqual(['hi', '\r']);
    expect(h.runner.isBusy()).toBe(true);

    reply.resolve(sessionWithAssistantTurns(1));
    await expect(begun.completed).resolves.toEqual({
      ok: true,
      session: sessionWithAssistantTurns(1),
    });
    expect(h.runner.isBusy()).toBe(false);
  });

  it('beginStartNew times out waiting for the adopted file and leaves the runner idle', async () => {
    const h = harness({
      autoReady: true,
      newest: ['/r/old.jsonl'],
      reads: [sessionWithAssistantTurns(0)],
      turnTimeoutMs: 3_000,
    });

    const begun = await h.runner.beginStartNew('/home/kai/project', 'hi');

    expect(begun.ok).toBe(false);
    expect(begun.ok === false && begun.error).toMatch(/new session file/i);
    expect(h.runner.isBusy()).toBe(false);
  });

  it('steers the run in flight with Enter and waits for the extra reply', async () => {
    const firstReply = deferred<ParsedPiSession>();
    const secondReply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      // baseline, then the first reply, then the steered one.
      reads: [sessionWithAssistantTurns(0), firstReply.promise, secondReply.promise],
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'one');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    await expect(h.runner.queue('/r/a.jsonl', 'use ripgrep', 'steer')).resolves.toEqual({ ok: true });
    // Same PTY, same shell: Enter is pi's steering key while a turn runs.
    expect(h.openPty).toHaveBeenCalledTimes(1);
    expect(h.handle.writes).toEqual(['one', '\r', 'use ripgrep', '\r']);

    // The first reply alone no longer settles the run: one more is owed.
    firstReply.resolve(sessionWithAssistantTurns(1));
    await flushMicrotasks();
    expect(h.runner.isBusy()).toBe(true);

    secondReply.resolve(sessionWithAssistantTurns(2));
    await expect(begun.completed).resolves.toEqual({
      ok: true,
      session: sessionWithAssistantTurns(2),
    });
    expect(h.runner.isBusy()).toBe(false);
  });

  it('queues a follow-up with Alt+Enter and waits for its reply too', async () => {
    const firstReply = deferred<ParsedPiSession>();
    const secondReply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), firstReply.promise, secondReply.promise],
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'one');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    await expect(h.runner.queue('/r/a.jsonl', 'then the tests', 'follow-up')).resolves.toEqual({
      ok: true,
    });
    // No Enter: the body goes in as an insert, and ESC CR is pi's
    // app.message.followUp — delivered only when the run has nothing left.
    expect(h.handle.writes).toEqual(['one', '\r', 'then the tests', '\u001b\r']);

    firstReply.resolve(sessionWithAssistantTurns(1));
    await flushMicrotasks();
    expect(h.runner.isBusy()).toBe(true);

    secondReply.resolve(sessionWithAssistantTurns(2));
    await expect(begun.completed).resolves.toMatchObject({ ok: true });
    expect(h.runner.isBusy()).toBe(false);
  });

  it('refuses to queue when no turn is running', async () => {
    const h = harness({ autoReady: true, reads: [sessionWithAssistantTurns(0)] });

    await expect(h.runner.queue('/r/a.jsonl', 'hi', 'steer')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/no running turn/i),
    });
    expect(h.openPty).not.toHaveBeenCalled();
  });

  it('tears the conversation session down once the reply has landed', async () => {
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), sessionWithAssistantTurns(1)],
    });

    await h.runner.send('/r/a.jsonl', 'hi');

    expect(h.closeSession).toHaveBeenCalledTimes(1);
    expect(h.closeSession)
      .toHaveBeenCalledWith(turnSessionName('/r/a.jsonl', '/home/kai/project'));
    // Closed and forgotten together: a record nobody will recheck is noise,
    // and one kept after a successful close would outlive its session.
    await flushMicrotasks();
    expect(h.forgetTurn).toHaveBeenCalledWith(turnSessionName('/r/a.jsonl', '/home/kai/project'));
  });

  it('writes the turn down so a connection arriving later can close it', async () => {
    const reply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), reply.promise],
      turnTimeoutMs: 1_000_000,
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'hi');
    expect(begun.ok).toBe(true);
    // The app is killed: this runner never sees the reply, so the record is
    // the only thing left that knows a session is owed a teardown.
    h.runner.dispose();
    if (begun.ok) await begun.completed;

    expect(h.rememberTurn).toHaveBeenCalledWith({
      sessionName: turnSessionName('/r/a.jsonl', '/home/kai/project'),
      sessionFile: '/r/a.jsonl',
      target: 1,
    });
    expect(h.forgetTurn).not.toHaveBeenCalled();
  });

  it('raises the recorded target when another message joins the run', async () => {
    const firstReply = deferred<ParsedPiSession>();
    const secondReply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), firstReply.promise, secondReply.promise],
    });
    const name = turnSessionName('/r/a.jsonl', '/home/kai/project');

    const begun = await h.runner.beginSend('/r/a.jsonl', 'one');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    await h.runner.queue('/r/a.jsonl', 'use ripgrep', 'steer');

    // A sweep that only knew about the first reply would close the session
    // while the steered instruction was still being worked on.
    expect(h.rememberTurn).toHaveBeenLastCalledWith({
      sessionName: name,
      sessionFile: '/r/a.jsonl',
      target: 2,
    });

    firstReply.resolve(sessionWithAssistantTurns(1));
    await flushMicrotasks();
    expect(h.forgetTurn).not.toHaveBeenCalled();

    secondReply.resolve(sessionWithAssistantTurns(2));
    await expect(begun.completed).resolves.toMatchObject({ ok: true });
    await flushMicrotasks();
    expect(h.forgetTurn).toHaveBeenCalledWith(name);
  });

  it('rolls the recorded target back when the extra message never landed', async () => {
    const reply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), reply.promise],
      turnTimeoutMs: 1_000_000,
    });
    const name = turnSessionName('/r/a.jsonl', '/home/kai/project');
    const begun = await h.runner.beginSend('/r/a.jsonl', 'one');
    expect(begun.ok).toBe(true);

    h.handle.write.mockImplementation(() => {
      throw new Error('pty closed');
    });
    const queued = await h.runner.queue('/r/a.jsonl', 'use ripgrep', 'steer');
    expect(queued.ok).toBe(false);

    // Nothing was asked of Pi, so nothing may be owed: a target one too high
    // would make the sweep wait for a reply that never comes and never clean.
    expect(h.rememberTurn).toHaveBeenLastCalledWith({
      sessionName: name,
      sessionFile: '/r/a.jsonl',
      target: 1,
    });
    h.runner.dispose();
  });

  it('leaves the session running when the poll gives up before the reply', async () => {
    const h = harness({ autoReady: true, reads: [sessionWithAssistantTurns(0)] });

    const result = await h.runner.send('/r/a.jsonl', 'hi');

    expect(result.ok).toBe(false);
    // The deadline bounded the poll, not the agent: it may still be working.
    expect(h.closeSession).not.toHaveBeenCalled();
  });

  it('never tears the session down when the connection goes away mid-turn', async () => {
    const reply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), reply.promise],
      turnTimeoutMs: 1_000_000,
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'hi');
    expect(begun.ok).toBe(true);
    h.runner.dispose();

    if (begun.ok) await expect(begun.completed).resolves.toMatchObject({ ok: false });
    expect(h.closeSession).not.toHaveBeenCalled();
  });

  it('drops the dead PTY on a reconnect and keeps the run', async () => {
    const reply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), reply.promise],
      turnTimeoutMs: 1_000_000,
    });
    const begun = await h.runner.beginSend('/r/a.jsonl', 'one');
    expect(begun.ok).toBe(true);

    h.runner.rebind();

    // The turn belongs to the host now, not to the channel watching it.
    expect(h.runner.isBusy()).toBe(true);
    expect(h.handle.close).toHaveBeenCalled();
    expect(h.handle.unsubscribe).toHaveBeenCalled();
    expect(h.closeSession).not.toHaveBeenCalled();

    h.runner.dispose();
  });

  it('re-attaches to the same session and delivers the line after a reconnect', async () => {
    const reply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), reply.promise],
      turnTimeoutMs: 1_000_000,
    });
    const begun = await h.runner.beginSend('/r/a.jsonl', 'one');
    expect(begun.ok).toBe(true);

    h.runner.rebind();
    await expect(h.runner.queue('/r/a.jsonl', 'two', 'steer')).resolves.toEqual({ ok: true });

    // A fresh PTY onto the transport that can carry it again — the same
    // command, so tmux attaches to the session Pi is still working in.
    expect(h.openPty).toHaveBeenCalledTimes(2);
    expect(h.openPty).toHaveBeenLastCalledWith(
      buildPiOpenCommand('/opt/bin/pi', '/home/kai/project', '/r/a.jsonl'),
      { cols: 80, rows: 24 },
    );
    expect(h.handle.writes).toEqual(['one', '\r', 'two', '\r']);

    h.runner.dispose();
  });

  it('re-attaches a draft to its own session, which its adopted file cannot name', async () => {
    const reply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(1), reply.promise],
      newest: [null, '/r/new.jsonl'],
      turnTimeoutMs: 1_000_000,
    });
    const begun = await h.runner.beginStartNew('/home/kai/project', 'one');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    h.runner.rebind();
    await expect(h.runner.queue('/r/new.jsonl', 'more', 'steer')).resolves.toEqual({ ok: true });

    // A draft's name is random, and its file derives a different one: deriving
    // it here would attach to nothing and start a *second* Pi on that file.
    const first = String(h.openPty.mock.calls[0]?.[0] ?? '');
    const second = String(h.openPty.mock.calls[1]?.[0] ?? '');
    const attached = /attach-session -d -t '([^']+)'/.exec(first)?.[1] ?? '';
    expect(attached).toMatch(/^ps-pi-draft-/);
    expect(second).toContain(`attach-session -d -t '${attached}'`);
    expect(second).not.toContain(turnSessionName('/r/new.jsonl', '/home/kai/project'));

    h.runner.dispose();
  });
});
