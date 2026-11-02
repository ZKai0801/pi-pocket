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
  /** Model the host ending the session: the channel dies and stops carrying bytes. */
  kill(): void;
  killed: boolean;
  /**
   * How many times this handle reported its own death. A real handle reports it
   * at most once (`PhoneApp.vue` guards it with the same `closed` flag that
   * stops its writes), so a fake that notified twice would let a double-drop
   * pass for the wrong reason.
   */
  closeNotifications: number;
  unsubscribe: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function sessionWithAssistantTurns(
  assistantTurns: number,
  settled: boolean = assistantTurns > 0,
): ParsedPiSession {
  const turns: ParsedPiSession['turns'] = [{ role: 'user', text: 'hi', timestampMs: 1 }];
  for (let index = 0; index < assistantTurns; index += 1) {
    turns.push({ role: 'assistant', text: `reply ${index}`, timestampMs: 2 + index });
  }
  // A turn held by the fixture is the run's final answer unless the file says
  // otherwise: `settled: false` models a run whose last message still owes
  // tool work (a narration with tool calls, or a trailing tool result).
  return { version: 3, id: 'a', cwd: '/home/kai/project', name: null, turns, settled };
}

function fakeHandle(
  options: {
    autoReady?: boolean;
    writeError?: Error;
    killAfterWrite?: number;
    dieAfterWrite?: number;
  } = {},
): FakeHandle {
  const listeners = new Set<(chunk: string) => void>();
  // Death watchers, mirroring `TurnPtyHandle.onClose`: the fake can be killed,
  // and a runner that never subscribed would simply never hear about it.
  const closeListeners = new Set<() => void>();
  const writes: string[] = [];
  let notified = false;
  const unsubscribe = vi.fn((callback: (chunk: string) => void) => {
    listeners.delete(callback);
  });

  const handle: FakeHandle = {
    writes,
    killed: false,
    closeNotifications: 0,
    write: vi.fn((data: string) => {
      if (options.writeError) throw options.writeError;
      // A dead channel accepts the bytes and loses them. The phone's `write` is
      // fire-and-forget and swallows the rejection it eventually gets back
      // (src/phone/PhoneApp.vue:640-657), so the caller sees neither a throw nor
      // an ack. Throwing here would model the `writeError` shape instead and
      // would let a test go green over the silent loss it is meant to catch.
      if (handle.killed) return;
      writes.push(data);
      if (options.killAfterWrite !== undefined && writes.length >= options.killAfterWrite) {
        handle.kill();
      }
      // The other shape of death: the bytes are accepted, and the channel only
      // reports its end a tick later. That is what the phone actually does —
      // `write` hands the payload to a queue, and the rejection it eventually
      // gets back becomes the close notification (src/phone/PhoneApp.vue:640-662).
      // `killAfterWrite` above is the synchronous form, which no real write
      // produces; a test that needs "the caller was never told" needs this one.
      if (options.dieAfterWrite !== undefined && writes.length >= options.dieAfterWrite) {
        queueMicrotask(() => handle.kill());
      }
    }),
    onData: vi.fn((callback: (chunk: string) => void) => {
      listeners.add(callback);
      if (options.autoReady) callback(PI_INPUT_READY_MARKER);
      return () => unsubscribe(callback);
    }),
    close: vi.fn(() => {
      // The runner put this handle down; its pump is gone, so nothing is left to
      // report. Only the host ending the session notifies.
      listeners.clear();
    }),
    unsubscribe,
    onClose(callback: () => void) {
      // Same contract as the phone's handle: a death that already happened is
      // reported to a late subscriber immediately, because a dead channel must
      // never be written into again.
      if (handle.closeNotifications > 0) {
        callback();
        return () => undefined;
      }
      closeListeners.add(callback);
      return () => { closeListeners.delete(callback); };
    },
    emit(chunk: string) {
      if (handle.killed) return;
      for (const listener of [...listeners]) listener(chunk);
    },
    kill() {
      if (handle.killed) return;
      handle.killed = true;
      // One notification per handle: a real EOF is an edge, not a level, so a
      // fake that fired twice would let a double-drop pass for the wrong reason.
      if (notified || handle.close.mock.calls.length > 0) return;
      notified = true;
      handle.closeNotifications += 1;
      for (const listener of [...closeListeners]) listener();
    },
  };
  return handle;
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
  /** Kill the session's handle when `closeSession` fires; the default is what really happens. */
  killOnClose?: boolean;
  /** Kill the handle from inside its own Nth write, to put a death mid-delivery. */
  killAfterWrite?: number;
  /** Let the handle report its death a tick *after* its Nth write, as the phone's queue does. */
  dieAfterWrite?: number;
}) {
  const handle = fakeHandle({
    autoReady: options.autoReady,
    writeError: options.writeError,
    killAfterWrite: options.killAfterWrite,
    dieAfterWrite: options.dieAfterWrite,
  });
  const handles: FakeHandle[] = [handle];
  let opens = 0;
  const reads = [...options.reads];
  const newest = [...(options.newest ?? [null])];
  const openPty = vi.fn(async (_command: string, _geometry: { cols: number; rows: number }) => {
    opens += 1;
    if (options.freshHandles !== true || opens === 1) return handle;
    const next = fakeHandle({
      autoReady: options.autoReady,
      writeError: options.writeError,
      killAfterWrite: options.killAfterWrite,
      dieAfterWrite: options.dieAfterWrite,
    });
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
  /**
   * Reality: `deps.closeSession` runs `tmux -L pocketshell-pi kill-session`, the
   * attach ends and the PTY hits EOF, so the handle dies with the session it
   * belongs to. A double whose session survives its own kill cannot express that
   * (spec §3.3), so killing is the default and `killOnClose: false` is the
   * opt-out a test has to justify.
   */
  const closeSession = vi.fn(async (_sessionName: string) => {
    if (options.killOnClose !== false) for (const owned of handles) owned.kill();
  });
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

  it('reopens the PTY when the first turn killed its session', async () => {
    // The first turn's settlement runs `tmux kill-session`, so the handle it
    // leaves behind is a corpse: reusing it for the next message is the loss
    // spec §3.2 describes, observed on a real host (Stage 0, Task 1 §4).
    const firstCompleted = sessionWithAssistantTurns(1);
    const h = harness({
      autoReady: true,
      freshHandles: true,
      reads: [sessionWithAssistantTurns(0), firstCompleted],
    });

    await expect(h.runner.send('/r/a.jsonl', 'one')).resolves.toMatchObject({ ok: true });
    expect(h.handle.killed).toBe(true);
    h.reads.push(sessionWithAssistantTurns(2));
    await expect(h.runner.send('/r/a.jsonl', 'two')).resolves.toMatchObject({ ok: true });

    expect(h.openPty).toHaveBeenCalledTimes(2);
    // The line has to reach the reopened channel. Asserting where the bytes
    // landed, not how many times something was called, is the point.
    expect(h.handles[1].writes).toEqual(['two', '\r']);
    expect(h.handle.writes).toEqual(['one', '\r']);
  });

  it('reports a dead channel, not a ten-minute timeout, when the turn PTY dies mid-delivery', async () => {
    // Death arrives between the line and the submit key — the shape the phone
    // actually produces, where `write` is fire-and-forget and the rejection it
    // gets back is swallowed (src/phone/PhoneApp.vue:640-657). The session file
    // never gains an assistant turn, because pi never received the line.
    const h = harness({
      autoReady: true,
      killAfterWrite: 1,
      reads: [sessionWithAssistantTurns(0)],
    });

    const result = await h.runner.send('/r/a.jsonl', 'hi');

    expect(result.ok).toBe(false);
    // The hazard is the spin: reporting a timeout after the whole turn deadline
    // means the runner treated a dead channel as usable and polled an unchanged
    // file for ten minutes. It has to fail at the death instead.
    expect(result.ok === false && result.error).not.toMatch(/timed out/i);
    expect(h.readSession).toHaveBeenCalledTimes(1);
    expect(h.handle.writes).toEqual(['hi']);
  });

  it('keeps the run to its reply when the PTY dies after the line is delivered', async () => {
    // D44, pinned rather than read: the phone's channel dying must never stop a
    // turn already in flight. `dropTurn()` forgets the PTY and touches nothing
    // else — the reply poll follows the session file through `readSession`, a
    // different channel entirely, so the run still answers.
    const reply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      freshHandles: true,
      reads: [sessionWithAssistantTurns(0), reply.promise],
    });

    const pending = h.runner.send('/r/a.jsonl', 'hi');
    await flushMicrotasks();
    // The line and its submit key are on the pane, pi is working, and the first
    // reply read is in flight.
    expect(h.handle.writes).toEqual(['hi', '\r']);
    h.handle.kill();

    reply.resolve(sessionWithAssistantTurns(1));
    await expect(pending).resolves.toMatchObject({ ok: true });

    // The dead handle went down exactly once — from the death, not again at the
    // settlement — and the turn still completed normally.
    expect(h.handle.close).toHaveBeenCalledTimes(1);
    expect(h.readSession).toHaveBeenCalledTimes(2);
    expect(h.runner.isBusy()).toBe(false);
  });

  it('reports a transport loss, not a delivery, when the channel dies after accepting the line', async () => {
    // `writeError` models a write that throws, and the runner fails by catching
    // it. Reality is quieter: the phone's `write` hands the bytes to a queue and
    // returns at once; the rejection that eventually comes back is swallowed
    // into a close notification (src/phone/PhoneApp.vue:640-662). Nothing throws
    // on this path, so only `onClose` can say the line never reached pi.
    const h = harness({
      autoReady: true,
      dieAfterWrite: 1,
      reads: [sessionWithAssistantTurns(0)],
    });

    const result = await h.runner.send('/r/a.jsonl', 'hi');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/transport/i);
    // The submit key never went out, and the runner has to stop there instead of
    // polling a file it knows nothing about.
    expect(h.handle.writes).toEqual(['hi']);
    expect(h.readSession).toHaveBeenCalledTimes(1);
    expect(h.runner.isBusy()).toBe(false);
  });

  it('reopens on every send after each turn killed its own session', async () => {
    // Recovery has to be repeatable, not once-only. Every answered turn ends
    // with `tmux kill-session`, so each settlement leaves a dead handle behind —
    // the third message needs the same fresh PTY the second did.
    const h = harness({
      autoReady: true,
      freshHandles: true,
      reads: [sessionWithAssistantTurns(0), sessionWithAssistantTurns(1)],
    });

    await expect(h.runner.send('/r/a.jsonl', 'one')).resolves.toMatchObject({ ok: true });
    h.reads.push(sessionWithAssistantTurns(2));
    await expect(h.runner.send('/r/a.jsonl', 'two')).resolves.toMatchObject({ ok: true });
    h.reads.push(sessionWithAssistantTurns(3));
    await expect(h.runner.send('/r/a.jsonl', 'three')).resolves.toMatchObject({ ok: true });

    expect(h.openPty).toHaveBeenCalledTimes(3);
    // Each line landed on the handle its own send opened — no message ever went
    // into a corpse.
    expect(h.handles.map((owned) => owned.writes)).toEqual([
      ['one', '\r'],
      ['two', '\r'],
      ['three', '\r'],
    ]);
    for (const owned of h.handles) expect(owned.killed).toBe(true);
  });

  it('reopens after a pi that died on its own without claiming a teardown it did not run', async () => {
    // Nothing the runner did ended this session — pi crashed. The death still
    // drops the handle, but a turn that got no answer must not report a kill it
    // never made: spec §3.4's record only goes away with a session the runner
    // actually destroyed.
    const noAnswer = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      freshHandles: true,
      reads: [sessionWithAssistantTurns(0), noAnswer.promise],
    });

    const crashed = h.runner.send('/r/a.jsonl', 'one');
    await flushMicrotasks();
    h.handle.kill();
    noAnswer.resolve(sessionWithAssistantTurns(0));

    await expect(crashed).resolves.toMatchObject({ ok: false });
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.forgetTurn).not.toHaveBeenCalled();
    expect(h.handle.close).toHaveBeenCalledTimes(1);

    // And the conversation is not stranded: the next send opens a clean PTY.
    h.reads.push(sessionWithAssistantTurns(1));
    await expect(h.runner.send('/r/a.jsonl', 'two')).resolves.toMatchObject({ ok: true });
    expect(h.openPty).toHaveBeenCalledTimes(2);
    expect(h.handles[1]?.writes).toEqual(['two', '\r']);
  });

  it('drops a superseded PTY once when the takeover session also dies', async () => {
    // A terminal-owning command marks the handle `restartPending`, so the next
    // line reopens it. When the host ends that session in between, the death has
    // already dropped it: a second drop would close a handle the runner no
    // longer owns, and a missed one would write into a corpse.
    const h = harness({
      autoReady: true,
      freshHandles: true,
      reads: [sessionWithAssistantTurns(0), sessionWithAssistantTurns(1)],
    });

    await expect(h.runner.runCommand('/r/a.jsonl', '/tree'))
      .resolves.toEqual({ ok: true, hiddenUi: true });
    // The command may still be running, so nothing is closed yet — and then the
    // host takes the session out from under it.
    expect(h.handle.close).not.toHaveBeenCalled();
    h.handle.kill();

    await expect(h.runner.send('/r/a.jsonl', 'hi')).resolves.toMatchObject({ ok: true });

    // One drop for two reasons to drop: the death put the handle down, and
    // `dropTurnIfSuperseded()` found nothing left to put down.
    expect(h.handle.close).toHaveBeenCalledTimes(1);
    expect(h.openPty).toHaveBeenCalledTimes(2);
    expect(h.handles[1]?.writes).toEqual(['hi', '\r']);
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
    // Attached in the one way that still means something after Stage 1a: the
    // turn was NOT answered, so D44 keeps its session — and keeps the live
    // handle bound to that file — in place. A settled turn's session is killed,
    // and its handle is now dropped as the dead channel it is, so nothing is
    // attached and there is nothing to refuse.
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0)],
      turnTimeoutMs: 5_000,
    });

    await expect(h.runner.send('/r/a.jsonl', 'hi')).resolves.toMatchObject({ ok: false });
    const result = await h.runner.startNew('/home/kai/project', 'new');

    expect(result).toEqual({ ok: false, error: SESSION_ALREADY_OPEN_ERROR });
    expect(h.openPty).toHaveBeenCalledTimes(1);
    expect(h.newestSessionFile).not.toHaveBeenCalled();
    expect(h.runner.isBusy()).toBe(false);
    // The session outlived the give-up: that survival is what makes the
    // attachment real, and it is the D44 rule this guard protects.
    expect(h.closeSession).not.toHaveBeenCalled();
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

  it('beginSend reports where the delivery spent its time', async () => {
    const reply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), reply.promise],
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'hi');
    if (!begun.ok) throw new Error('the delivery should have started');
    reply.resolve(sessionWithAssistantTurns(1));
    await begun.completed;

    // One number per stage of the delay the bubble's spinner covers: the only
    // way to tell which of them is worth shortening.
    expect(begun.timings).toMatchObject({
      openMs: expect.any(Number),
      readyMs: expect.any(Number),
      baselineMs: expect.any(Number),
      deliverMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
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

  it('does not settle — or kill the session — while the reply still owes tool work', async () => {
    // The file as pi really writes it during a run: the assistant's narration
    // text lands before the tool calls in that same message run, then the
    // tool's result, and only then a message without tool calls. The count
    // reaches its target on the very first read; only the tail tells the
    // difference between "answered" and "still working".
    const narration = sessionWithAssistantTurns(1, false);
    const toolResultLanded = sessionWithAssistantTurns(1, false);
    const answered = sessionWithAssistantTurns(1, true);
    const tail = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), narration, toolResultLanded, tail.promise],
      turnTimeoutMs: 1_000_000,
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'run the build');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    await flushMicrotasks();

    // The narration reached the turn count while the tool was still running:
    // this is exactly the read that used to be taken for "answered" and got
    // the agent killed mid-run (the background-running bug).
    expect(h.runner.isBusy()).toBe(true);
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.forgetTurn).not.toHaveBeenCalled();

    tail.resolve(answered);
    await expect(begun.completed).resolves.toEqual({ ok: true, session: answered });
    expect(h.closeSession).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(h.forgetTurn).toHaveBeenCalledWith(turnSessionName('/r/a.jsonl', '/home/kai/project'));
  });

  it('does not settle while the file says pi will ask the model again', async () => {
    // The count is reached and the tail is exactly what a finished run leaves
    // — an assistant message with nothing left to run — but the message says
    // why it stopped, and pi's loop continues for a truncated or failed
    // response. Settling here would paint the half-run as the reply and kill
    // the session the retry is about to run in.
    const willContinue: ParsedPiSession = {
      version: 3,
      id: 'a',
      cwd: '/home/kai/project',
      name: null,
      turns: [
        { role: 'user', text: 'run the build', timestampMs: 1 },
        { role: 'assistant', text: 'on it', timestampMs: 2 },
      ],
      settled: true,
      stopReason: 'length',
      entryCount: 7,
    };
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), willContinue],
      turnTimeoutMs: 1_000_000,
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'run the build');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    await flushMicrotasks();

    expect(h.runner.isBusy()).toBe(true);
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.forgetTurn).not.toHaveBeenCalled();
  });

  it('settles a tail that stopped for good once the file stops growing', async () => {
    // The same non-final reason as above, but pi never appends the entry it
    // writes before a retry: a file that has not moved is a run that gave up,
    // so the turn settles instead of reporting running until the deadline and
    // leaving its session for a sweep that cannot tell either.
    const gaveUp: ParsedPiSession = {
      version: 3,
      id: 'a',
      cwd: '/home/kai/project',
      name: null,
      turns: [
        { role: 'user', text: 'run the build', timestampMs: 1 },
        { role: 'assistant', text: 'on it', timestampMs: 2 },
      ],
      settled: true,
      stopReason: 'error',
      entryCount: 7,
    };
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), gaveUp],
      turnTimeoutMs: 1_000_000,
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'run the build');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    await expect(begun.completed).resolves.toMatchObject({ ok: true, session: gaveUp });
    expect(h.closeSession).toHaveBeenCalledTimes(1);
  });

  it('settles a run pi gave up on, whose failure left no reply to count', async () => {
    // The reported case: the provider answered `500: billing service
    // unavailable`, pi wrote an assistant message with no text and stopped.
    // The assistant-turn count can never reach the target (there is no reply),
    // so without the tail's own `error` the chat reports running for the whole
    // deadline and the failure never reaches the screen.
    const gaveUp: ParsedPiSession = {
      version: 3,
      id: 'a',
      cwd: '/home/kai/project',
      name: null,
      turns: [
        { role: 'user', text: 'run the build', timestampMs: 1 },
        { role: 'assistant', text: 'on it', timestampMs: 2 },
      ],
      errors: [
        { text: '500: billing service unavailable', timestampMs: 3, afterTurns: 2 },
      ],
      settled: true,
      stopReason: 'error',
      entryCount: 8,
    };
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(1), gaveUp],
      turnTimeoutMs: 1_000_000,
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'run the build');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    await expect(begun.completed).resolves.toMatchObject({ ok: true, session: gaveUp });
    expect(h.closeSession).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting while a run that may continue keeps appending entries', async () => {
    // Pi's retry appends a `context_edit` before it waits: the file growing is
    // the sign a run is not over, so the run is still busy when it happens and
    // settles on the reply the retry finally wrote.
    const tail = (stopReason: string, entryCount: number): ParsedPiSession => ({
      version: 3,
      id: 'a',
      cwd: '/home/kai/project',
      name: null,
      turns: [
        { role: 'user', text: 'run the build', timestampMs: 1 },
        { role: 'assistant', text: 'on it', timestampMs: 2 },
      ],
      settled: true,
      stopReason,
      entryCount,
    });
    const answered = tail('stop', 9);
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), tail('error', 7), tail('error', 8), answered],
      turnTimeoutMs: 1_000_000,
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'run the build');
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;

    await expect(begun.completed).resolves.toMatchObject({ ok: true, session: answered });
    expect(h.closeSession).toHaveBeenCalledTimes(1);
  });

  it('refuses the send when the baseline read never succeeds', async () => {
    // A baseline that silently defaulted to zero would let the poll see the
    // conversation's previous idle tail as this run's answer and tear the
    // session down right after the line landed, so an unreadable baseline has
    // to refuse the turn instead of guessing.
    const h = harness({
      autoReady: true,
      reads: [new Error('sftp down')],
      turnTimeoutMs: 3_000,
    });

    const result = await h.runner.send('/r/a.jsonl', 'hi');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/timed out/i);
    expect(h.handle.writes).toEqual([]);
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.rememberTurn).not.toHaveBeenCalled();
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

  it('keeps watching a run across a reconnect and settles once the reads come back', async () => {
    // A phone that loses its link mid-turn: the PTY is gone, the reads throw
    // until the transport is back, and the reply is waiting on the other side.
    // Nothing on this side may be disposed — the settlement is the reply's.
    const offline = new Error('No live SSH connection.');
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0), offline, offline, sessionWithAssistantTurns(1)],
      turnTimeoutMs: 1_000_000,
    });

    const begun = await h.runner.beginSend('/r/a.jsonl', 'one');
    expect(begun.ok).toBe(true);
    h.runner.rebind();
    expect(h.runner.isBusy()).toBe(true);

    if (begun.ok) await expect(begun.completed).resolves.toMatchObject({ ok: true });
    expect(h.runner.isBusy()).toBe(false);
    // The run was answered, so the host's tmux session is closed exactly once.
    expect(h.closeSession).toHaveBeenCalledTimes(1);
    expect(h.closeSession).toHaveBeenLastCalledWith(turnSessionName('/r/a.jsonl', '/home/kai/project'));
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

  it('adopt: watches a turn nobody here delivered, and closes its session when the reply lands', async () => {
    // The app was killed mid-turn. The record it left names the file, the
    // count that means answered and the tmux session, which is everything a
    // watcher needs — the agent is already running.
    const h = harness({
      reads: [sessionWithAssistantTurns(0), sessionWithAssistantTurns(1)],
    });

    await expect(
      h.runner.adopt({ sessionFile: '/r/a.jsonl', target: 1, sessionName: 'ps-pi-orphan' }),
    ).resolves.toMatchObject({ ok: true });

    // Nothing typed, no PTY opened: this turn was delivered in another life.
    expect(h.openPty).not.toHaveBeenCalled();
    expect(h.handle.writes).toEqual([]);
    // …but the cleanup the dead watcher would have done is this one's job.
    await flushMicrotasks();
    expect(h.closeSession).toHaveBeenCalledWith('ps-pi-orphan');
    expect(h.forgetTurn).toHaveBeenCalledWith('ps-pi-orphan');
    expect(h.runner.isBusy()).toBe(false);
  });

  it('adopt: keeps waiting while the adopted turn still owes replies', async () => {
    const h = harness({
      reads: [
        // Tool work still running: the file has the first reply but does not
        // settle, so this must not be taken as the end of the run.
        sessionWithAssistantTurns(1, false),
        sessionWithAssistantTurns(2),
      ],
    });

    await expect(
      h.runner.adopt({ sessionFile: '/r/a.jsonl', target: 2, sessionName: 'ps-pi-orphan' }),
    ).resolves.toMatchObject({ ok: true });

    expect(h.readSession).toHaveBeenCalledTimes(2);
    expect(h.closeSession).toHaveBeenCalledTimes(1);
  });

  it('adopt: writes the record before it starts watching, so a deadline still leaves the cleanup', async () => {
    const h = harness({
      reads: [sessionWithAssistantTurns(0), new Error('ssh gone')],
      turnTimeoutMs: 5_000,
    });

    await expect(
      h.runner.adopt({ sessionFile: '/r/a.jsonl', target: 2, sessionName: 'ps-pi-orphan' }),
    ).resolves.toMatchObject({ ok: false });

    expect(h.rememberTurn).toHaveBeenCalledWith({
      sessionName: 'ps-pi-orphan',
      sessionFile: '/r/a.jsonl',
      target: 2,
    });
    // A watch that gave up is not a turn that failed: nothing is killed.
    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.forgetTurn).not.toHaveBeenCalled();
  });

  it('adopt: refuses while this runner is already watching a turn', async () => {
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(0)],
      neverSettles: true,
      turnTimeoutMs: 1_000_000,
    });
    void h.runner.send('/r/a.jsonl', 'one');
    await flushMicrotasks();

    await expect(
      h.runner.adopt({ sessionFile: '/r/a.jsonl', target: 1, sessionName: 'ps-pi-orphan' }),
    ).resolves.toMatchObject({ ok: false });
    expect(h.openPty).toHaveBeenCalledTimes(1);

    h.runner.dispose();
  });

  it('adopt: a steering message re-attaches to the session the adopted turn runs in', async () => {
    const reply = deferred<ParsedPiSession>();
    const h = harness({
      autoReady: true,
      reads: [sessionWithAssistantTurns(1, false), reply.promise],
    });

    const watching = h.runner.adopt({
      sessionFile: '/r/a.jsonl',
      target: 1,
      sessionName: 'ps-pi-orphan',
    });
    await flushMicrotasks();

    await expect(h.runner.queue('/r/a.jsonl', 'go left', 'steer')).resolves.toEqual({ ok: true });
    // The adopted session's own name, so the line reaches the agent that is
    // working instead of starting a second Pi on the same file.
    expect(String(h.openPty.mock.calls[0]?.[0] ?? '')).toContain('ps-pi-orphan');
    expect(h.handle.writes).toEqual(['go left', '\r']);

    // One more reply is owed now; the run settles on the second one.
    reply.resolve(sessionWithAssistantTurns(2));
    await expect(watching).resolves.toMatchObject({ ok: true });
    expect(h.closeSession).toHaveBeenCalledWith('ps-pi-orphan');
  });
});
