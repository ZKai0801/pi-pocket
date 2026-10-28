import { describe, expect, it, vi } from 'vitest';
import {
  countAssistantTurns,
  createMemoryPendingTurnStorage,
  DEFAULT_PENDING_TURN_POLICY,
  isRunAnswered,
  isUsablePendingTurn,
  PENDING_TURN_SCHEMA,
  PendingTurns,
  reconcilePendingTurns,
  type PendingTurn,
} from '../../src/pi/pendingTurns';
import { parsePiSession } from '../../src/pi/parsePiSession';
import type { ParsedPiSession } from '../../src/pi/types';

function sessionWithAssistantTurns(
  assistantTurns: number,
  settled: boolean = assistantTurns > 0,
): ParsedPiSession {
  const turns: ParsedPiSession['turns'] = [{ role: 'user', text: 'hi', timestampMs: 1 }];
  for (let index = 0; index < assistantTurns; index += 1) {
    turns.push({ role: 'assistant', text: `reply ${index}`, timestampMs: 2 + index });
  }
  // `settled: false` models a run whose last file entry still owes tool work —
  // the state a narrating model leaves seconds into a run.
  return { version: 3, id: 'a', cwd: '/home/kai/project', name: null, turns, settled };
}

function record(overrides: Partial<PendingTurn> = {}): PendingTurn {
  return {
    schema: PENDING_TURN_SCHEMA,
    host: 'box',
    sessionName: 'ps-pi-abc',
    sessionFile: '/r/a.jsonl',
    target: 1,
    startedAtMs: 1_000,
    ...overrides,
  };
}

function storeWith(entries: PendingTurn[], nowMs = 2_000): PendingTurns {
  const storage = createMemoryPendingTurnStorage();
  for (const entry of entries) void storage.put(entry);
  return new PendingTurns(storage, DEFAULT_PENDING_TURN_POLICY, () => nowMs);
}

// One top-level describe for the whole file: the unit gate's manifest
// registers exactly one suite per file, so several describes would keep the
// file out of the registered set (the gap 841a7347 left this file in).
describe('pending turns', () => {
  it('countAssistantTurns: counts merged turns, not assistant entries', () => {
    // A reply plus its tool calls is several assistant entries and one turn,
    // which is why the sweep cannot count lines of JSONL the way a shell could.
    const jsonl = [
      '{"type":"session","version":3,"id":"a"}',
      '{"type":"message","message":{"role":"user","content":"run the tests"}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"on it"}]}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","text":""}]}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
    ].join('\n');

    expect(countAssistantTurns(parsePiSession(jsonl))).toBe(1);
  });

  it('isRunAnswered: does not call a run answered while its narration still owes tool work', () => {
    // Same file as above, read one entry earlier: the assistant's text is in
    // the file, its tool call has not run. The count alone would say
    // "answered"; pi writes text before it works, so it must not.
    const jsonl = [
      '{"type":"session","version":3,"id":"a"}',
      '{"type":"message","message":{"role":"user","content":"run the tests"}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"on it"}]}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","text":""}]}}',
    ].join('\n');

    const parsed = parsePiSession(jsonl);
    expect(countAssistantTurns(parsed)).toBe(1);
    expect(parsed.settled).toBe(false);
    expect(isRunAnswered(parsed, 1)).toBe(false);
  });

  it('isRunAnswered: calls a run answered only when the count is reached and the tail is settled', () => {
    const finished = parsePiSession([
      '{"type":"session","version":3,"id":"a"}',
      '{"type":"message","message":{"role":"user","content":"run the tests"}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"on it"}]}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","text":""}]}}',
      '{"type":"message","message":{"role":"toolResult","toolCallId":"c1","content":[{"type":"text","text":"ok"}]}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
    ].join('\n'));

    expect(isRunAnswered(finished, 1)).toBe(true);
    expect(isRunAnswered(finished, 2)).toBe(false);
  });

  it('isRunAnswered: keeps a run whose last message says pi will ask again', () => {
    // The tail is exactly what a finished run leaves — an assistant message
    // with nothing left to run — and the count is reached. Pi's loop keeps
    // going for every stop reason but a final one: `toolUse` still owes the
    // tool calls, and a truncated or failed response is recovered by a retry,
    // a compaction or a continuation. Only the reason separates them, and
    // settling on the tail alone is what killed turns mid-flight.
    const withReason = (reason: string): ParsedPiSession =>
      parsePiSession([
        '{"type":"session","version":3,"id":"a"}',
        '{"type":"message","message":{"role":"user","content":"run the tests"}}',
        `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"on it"}],"stopReason":"${reason}"}}`,
      ].join('\n'));

    for (const reason of ['toolUse', 'length', 'error', 'pending', 'deferred']) {
      const parsed = withReason(reason);
      expect(parsed.settled).toBe(true);
      expect(isRunAnswered(parsed, 1)).toBe(false);
    }
    expect(isRunAnswered(withReason('stop'), 1)).toBe(true);
    expect(isRunAnswered(withReason('aborted'), 1)).toBe(true);
  });

  it('isRunAnswered: reads a file that records no stop reason by its tail', () => {
    // Nothing to contradict the tail: the run is judged the way it always was.
    const jsonl = [
      '{"type":"session","version":3,"id":"a"}',
      '{"type":"message","message":{"role":"user","content":"hi"}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
    ].join('\n');

    expect(isRunAnswered(parsePiSession(jsonl), 1)).toBe(true);
  });

  it('PendingTurns: remembers a turn for the host it runs on and no other', async () => {
    const store = storeWith([]);

    await store.remember('box', { sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 2 });

    const onBox = await store.onHost('box');
    expect(onBox).toHaveLength(1);
    expect(onBox[0]).toMatchObject({
      schema: PENDING_TURN_SCHEMA,
      host: 'box',
      sessionName: 'ps-pi-a',
      sessionFile: '/r/a.jsonl',
      target: 2,
    });
    expect(await store.onHost('laptop')).toEqual([]);
    expect(await store.onHost(null)).toEqual([]);
  });

  it('PendingTurns: overwrites the record when the same conversation sends again', async () => {
    const store = storeWith([]);

    await store.remember('box', { sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 1 });
    await store.remember('box', { sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 3 });

    const entries = await store.onHost('box');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.target).toBe(3);
  });

  it('PendingTurns: forgets a settled run', async () => {
    const store = storeWith([record()]);

    await store.forget('box', 'ps-pi-abc');

    expect(await store.onHost('box')).toEqual([]);
  });

  it('PendingTurns: drops a record past its ttl instead of acting on it', async () => {
    const stale = record({ startedAtMs: 0 });
    const store = storeWith([stale], DEFAULT_PENDING_TURN_POLICY.ttlMs + 1);

    expect(await store.onHost('box')).toEqual([]);
    // The next write sweeps it out for good.
    await store.remember('box', { sessionName: 'ps-pi-new', sessionFile: '/r/b.jsonl', target: 1 });
    const entries = await store.onHost('box');
    expect(entries.map((entry) => entry.sessionName)).toEqual(['ps-pi-new']);
  });

  it('PendingTurns: keeps the cap by dropping the oldest records', async () => {
    const entries = Array.from({ length: DEFAULT_PENDING_TURN_POLICY.maxTurns + 2 }, (_, index) =>
      record({ sessionName: `ps-pi-${index}`, startedAtMs: 1_000 + index }),
    );
    const store = storeWith(entries);

    await store.sweep();

    const kept = await store.onHost('box');
    expect(kept).toHaveLength(DEFAULT_PENDING_TURN_POLICY.maxTurns);
    expect(kept.map((entry) => entry.sessionName)).not.toContain('ps-pi-0');
    expect(kept.map((entry) => entry.sessionName)).not.toContain('ps-pi-1');
  });

  it('PendingTurns: rejects a record from another build or with unusable fields', () => {
    expect(isUsablePendingTurn(record())).toBe(true);
    expect(isUsablePendingTurn(record({ schema: PENDING_TURN_SCHEMA + 1 }))).toBe(false);
    expect(isUsablePendingTurn(record({ sessionName: '' }))).toBe(false);
    expect(isUsablePendingTurn(record({ sessionFile: '' }))).toBe(false);
    expect(isUsablePendingTurn(record({ target: 0 }))).toBe(false);
    expect(isUsablePendingTurn(record({ target: 1.5 }))).toBe(false);
    expect(isUsablePendingTurn({ ...record(), target: '2' })).toBe(false);
    expect(isUsablePendingTurn(null)).toBe(false);
  });

  function sweepWith(options: {
    entries: PendingTurn[];
    sessions: Record<string, ParsedPiSession | Error>;
    /** The tmux sessions that still exist; omitted means the host is not probed. */
    alive?: string[];
    /** The probe itself fails (an SSH hiccup), as opposed to answering "gone". */
    probeThrows?: boolean;
    /** The host's live turn listing; omitted means it could not be asked. */
    live?: { sessionName: string; sessionFile: string }[];
  }) {
    const readSession = vi.fn(async (path: string) => {
      const next = options.sessions[path] ?? new Error('no such file');
      if (next instanceof Error) throw next;
      return next;
    });
    const kill = vi.fn(async (_sessionName: string) => undefined);
    const forget = vi.fn(async (_host: string, _sessionName: string) => undefined);
    const hasSession = options.alive === undefined
      ? undefined
      : vi.fn(async (sessionName: string) => {
          if (options.probeThrows === true) throw new Error('probe failed');
          return options.alive?.includes(sessionName) ?? false;
        });
    const run = () =>
      reconcilePendingTurns({
        host: 'box',
        list: async (host) =>
          options.entries.filter((entry) => (host === 'box' ? entry.host === 'box' : false)),
        liveTurns: options.live,
        readSession,
        kill,
        hasSession,
        forget,
      });
    return { readSession, kill, forget, hasSession, run };
  }

  it('reconcilePendingTurns: closes and forgets a session whose turn was answered while nobody watched', async () => {
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 2 });
    const sweep = sweepWith({
      entries: [turn],
      sessions: { '/r/a.jsonl': sessionWithAssistantTurns(2) },
    });

    await expect(sweep.run()).resolves.toMatchObject({ closed: 1, running: [] });

    expect(sweep.kill).toHaveBeenCalledWith('ps-pi-a');
    expect(sweep.forget).toHaveBeenCalledWith('box', 'ps-pi-a');
  });

  it('reconcilePendingTurns: hands a still-running turn back so it can be watched again', async () => {
    // The app was killed mid-turn; the agent kept working. This record is the
    // only reason anyone still knows the conversation has a turn in flight.
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 2 });
    const session = sessionWithAssistantTurns(1);
    const sweep = sweepWith({ entries: [turn], sessions: { '/r/a.jsonl': session } });

    const settlement = await sweep.run();

    expect(settlement.closed).toBe(0);
    expect(settlement.running).toHaveLength(1);
    expect(settlement.running[0]?.sessionName).toBe('ps-pi-a');
    expect(settlement.running[0]?.target).toBe(2);
    // The parse comes back with it: the caller needs the conversation's own
    // directory to build a runner for a chat that is not open.
    expect(settlement.running[0]?.session).toBe(session);
    expect(sweep.kill).not.toHaveBeenCalled();
    expect(sweep.forget).not.toHaveBeenCalled();
  });

  it('reconcilePendingTurns: leaves a session alone when the count is reached but tools are still running', async () => {
    // The phone went away right after sending; by the time it reconnects, the
    // model has narrated (one text turn in the file) and is deep in a tool
    // call. The count matches the record's target; the tail does not settle.
    // This sweep used to kill exactly this session on reconnect — the
    // background-turn bug.
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 1 });
    const sweep = sweepWith({
      entries: [turn],
      sessions: { '/r/a.jsonl': sessionWithAssistantTurns(1, false) },
    });

    await expect(sweep.run()).resolves.toMatchObject({
      closed: 0,
      running: [{ sessionName: 'ps-pi-a', target: 1 }],
    });

    expect(sweep.kill).not.toHaveBeenCalled();
    expect(sweep.forget).not.toHaveBeenCalled();
  });

  it('reconcilePendingTurns: adopts a turn the host still runs when no record names it', async () => {
    // The reinstall / "clear data" case: nothing local remembers this turn —
    // the app's own storage was wiped — and the agent is still working. The
    // host's session listing is the only thing that knows, which is why the
    // running status has to come from there.
    const session = sessionWithAssistantTurns(1, false);
    const sweep = sweepWith({
      entries: [],
      sessions: { '/r/a.jsonl': session },
      live: [{ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl' }],
    });

    const settlement = await sweep.run();

    expect(settlement.running).toHaveLength(1);
    expect(settlement.running[0]).toMatchObject({
      sessionName: 'ps-pi-a',
      sessionFile: '/r/a.jsonl',
      // No record, so the file's own count is the baseline: it is already
      // reached, which leaves the settled tail and the stop reason as the
      // whole test — exactly "the run is still at work".
      target: countAssistantTurns(session),
    });
    expect(sweep.kill).not.toHaveBeenCalled();
  });

  it('reconcilePendingTurns: closes a delivered turn the host still lists but is at rest', async () => {
    // The reply landed while the phone was away; the pane is idle and this app
    // delivered the turn, so the teardown D44 promises is this pass's job.
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 2 });
    const sweep = sweepWith({
      entries: [turn],
      sessions: { '/r/a.jsonl': sessionWithAssistantTurns(2) },
      live: [{ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl' }],
    });

    await expect(sweep.run()).resolves.toMatchObject({ closed: 1, running: [] });

    expect(sweep.kill).toHaveBeenCalledWith('ps-pi-a');
    expect(sweep.forget).toHaveBeenCalledWith('box', 'ps-pi-a');
  });

  it('reconcilePendingTurns: leaves an at-rest pane alone when no record says this app sent it', async () => {
    // An at-rest file cannot tell "pi finished that turn" from "pi has not
    // started writing the next one yet". With no record of having delivered
    // the line, killing on that guess would destroy work the phone cannot see,
    // so the pane is left exactly as it is — and nothing is reported running.
    const sweep = sweepWith({
      entries: [],
      sessions: { '/r/a.jsonl': sessionWithAssistantTurns(2) },
      live: [{ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl' }],
    });

    await expect(sweep.run()).resolves.toMatchObject({ closed: 0, running: [] });

    expect(sweep.kill).not.toHaveBeenCalled();
  });

  it('reconcilePendingTurns: keeps the recorded count for a live turn with more replies owed', async () => {
    // One assistant turn is in the file, a steering line is still owed: only
    // the record knows this run settles at two, and the host listing cannot
    // supply it.
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 2 });
    const sweep = sweepWith({
      entries: [turn],
      sessions: { '/r/a.jsonl': sessionWithAssistantTurns(1) },
      live: [{ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl' }],
    });

    await expect(sweep.run()).resolves.toMatchObject({
      closed: 0,
      running: [{ sessionName: 'ps-pi-a', target: 2 }],
    });
  });

  it('reconcilePendingTurns: retires a record the host does not list', async () => {
    // With the listing in hand, a session that is not in it is provably gone —
    // no per-record probe needed.
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 2 });
    const sweep = sweepWith({
      entries: [turn],
      sessions: { '/r/a.jsonl': sessionWithAssistantTurns(1) },
      live: [],
    });

    await expect(sweep.run()).resolves.toMatchObject({ gone: 1, running: [] });

    expect(sweep.forget).toHaveBeenCalledWith('box', 'ps-pi-a');
    expect(sweep.kill).not.toHaveBeenCalled();
  });

  it('reconcilePendingTurns: drops a record whose tmux session no longer exists', async () => {
    // Pi exited (or the host rebooted) before the reply was ever written: no
    // watcher can join that pane, and no cleanup is owed. Keeping the record
    // would report a turn as running in a session that is gone.
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 2 });
    const sweep = sweepWith({
      entries: [turn],
      sessions: { '/r/a.jsonl': sessionWithAssistantTurns(1) },
      alive: [],
    });

    await expect(sweep.run()).resolves.toMatchObject({ gone: 1, running: [] });

    expect(sweep.forget).toHaveBeenCalledWith('box', 'ps-pi-a');
    expect(sweep.kill).not.toHaveBeenCalled();
  });

  it('reconcilePendingTurns: keeps the record when the session probe cannot answer', async () => {
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 2 });
    const sweep = sweepWith({
      entries: [turn],
      sessions: { '/r/a.jsonl': sessionWithAssistantTurns(1) },
      alive: ['ps-pi-a'],
      probeThrows: true,
    });

    await expect(sweep.run()).resolves.toMatchObject({ unreadable: 1, running: [], gone: 0 });

    expect(sweep.forget).not.toHaveBeenCalled();
  });

  it('reconcilePendingTurns: keeps the record when the file cannot be read, so the next connection retries', async () => {
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/gone.jsonl' });
    const sweep = sweepWith({ entries: [turn], sessions: {} });

    await expect(sweep.run()).resolves.toMatchObject({ closed: 0, unreadable: 1, running: [] });

    expect(sweep.kill).not.toHaveBeenCalled();
    expect(sweep.forget).not.toHaveBeenCalled();
  });

  it('reconcilePendingTurns: does not let a failed kill drop the record', async () => {
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl' });
    const sweep = sweepWith({
      entries: [turn],
      sessions: { '/r/a.jsonl': sessionWithAssistantTurns(1) },
    });
    sweep.kill.mockRejectedValueOnce(new Error('ssh gone'));

    // Nothing was closed, so nothing is reported as closed.
    await expect(sweep.run()).resolves.toMatchObject({ closed: 0 });

    // The kill never happened, so the record has to survive for the retry.
    expect(sweep.forget).not.toHaveBeenCalled();
  });

  it('reconcilePendingTurns: does nothing at all without a host', async () => {
    const list = vi.fn(async () => [record()]);
    const kill = vi.fn(async () => undefined);

    await expect(
      reconcilePendingTurns({
        host: null,
        list,
        readSession: async () => sessionWithAssistantTurns(1),
        kill,
        forget: async () => undefined,
      }),
    ).resolves.toMatchObject({ closed: 0, running: [] });
    expect(kill).not.toHaveBeenCalled();
  });
});
