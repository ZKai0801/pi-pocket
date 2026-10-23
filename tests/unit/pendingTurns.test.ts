import { describe, expect, it, vi } from 'vitest';
import {
  countAssistantTurns,
  createMemoryPendingTurnStorage,
  DEFAULT_PENDING_TURN_POLICY,
  isUsablePendingTurn,
  PENDING_TURN_SCHEMA,
  PendingTurns,
  sweepAnsweredTurns,
  type PendingTurn,
} from '../../src/pi/pendingTurns';
import { parsePiSession } from '../../src/pi/parsePiSession';
import type { ParsedPiSession } from '../../src/pi/types';

function sessionWithAssistantTurns(assistantTurns: number): ParsedPiSession {
  const turns: ParsedPiSession['turns'] = [{ role: 'user', text: 'hi', timestampMs: 1 }];
  for (let index = 0; index < assistantTurns; index += 1) {
    turns.push({ role: 'assistant', text: `reply ${index}`, timestampMs: 2 + index });
  }
  return { version: 3, id: 'a', cwd: '/home/kai/project', name: null, turns };
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

describe('countAssistantTurns', () => {
  it('counts merged turns, not assistant entries', () => {
    // A reply plus its tool calls is several assistant entries and one turn,
    // which is why the sweep cannot count lines of JSONL the way a shell would.
    const jsonl = [
      '{"type":"session","version":3,"id":"a"}',
      '{"type":"message","message":{"role":"user","content":"run the tests"}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"on it"}]}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","text":""}]}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}',
    ].join('\n');

    expect(countAssistantTurns(parsePiSession(jsonl))).toBe(1);
  });
});

describe('PendingTurns', () => {
  it('remembers a turn for the host it runs on and no other', async () => {
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

  it('overwrites the record when the same conversation sends again', async () => {
    const store = storeWith([]);

    await store.remember('box', { sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 1 });
    await store.remember('box', { sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 3 });

    const entries = await store.onHost('box');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.target).toBe(3);
  });

  it('forgets a settled run', async () => {
    const store = storeWith([record()]);

    await store.forget('box', 'ps-pi-abc');

    expect(await store.onHost('box')).toEqual([]);
  });

  it('drops a record past its ttl instead of acting on it', async () => {
    const stale = record({ startedAtMs: 0 });
    const store = storeWith([stale], DEFAULT_PENDING_TURN_POLICY.ttlMs + 1);

    expect(await store.onHost('box')).toEqual([]);
    // The next write sweeps it out for good.
    await store.remember('box', { sessionName: 'ps-pi-new', sessionFile: '/r/b.jsonl', target: 1 });
    const entries = await store.onHost('box');
    expect(entries.map((entry) => entry.sessionName)).toEqual(['ps-pi-new']);
  });

  it('keeps the cap by dropping the oldest records', async () => {
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

  it('rejects a record from another build or with unusable fields', () => {
    expect(isUsablePendingTurn(record())).toBe(true);
    expect(isUsablePendingTurn(record({ schema: PENDING_TURN_SCHEMA + 1 }))).toBe(false);
    expect(isUsablePendingTurn(record({ sessionName: '' }))).toBe(false);
    expect(isUsablePendingTurn(record({ sessionFile: '' }))).toBe(false);
    expect(isUsablePendingTurn(record({ target: 0 }))).toBe(false);
    expect(isUsablePendingTurn(record({ target: 1.5 }))).toBe(false);
    expect(isUsablePendingTurn({ ...record(), target: '2' })).toBe(false);
    expect(isUsablePendingTurn(null)).toBe(false);
  });
});

describe('sweepAnsweredTurns', () => {
  function sweepWith(options: {
    entries: PendingTurn[];
    sessions: Record<string, ParsedPiSession | Error>;
  }) {
    const readSession = vi.fn(async (path: string) => {
      const next = options.sessions[path] ?? new Error('no such file');
      if (next instanceof Error) throw next;
      return next;
    });
    const kill = vi.fn(async (_sessionName: string) => undefined);
    const forget = vi.fn(async (_host: string, _sessionName: string) => undefined);
    const run = () =>
      sweepAnsweredTurns({
        host: 'box',
        list: async (host) =>
          options.entries.filter((entry) => (host === 'box' ? entry.host === 'box' : false)),
        readSession,
        kill,
        forget,
      });
    return { readSession, kill, forget, run };
  }

  it('closes and forgets a session whose turn was answered while nobody watched', async () => {
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 2 });
    const sweep = sweepWith({
      entries: [turn],
      sessions: { '/r/a.jsonl': sessionWithAssistantTurns(2) },
    });

    await expect(sweep.run()).resolves.toBe(1);

    expect(sweep.kill).toHaveBeenCalledWith('ps-pi-a');
    expect(sweep.forget).toHaveBeenCalledWith('box', 'ps-pi-a');
  });

  it('leaves a session alone while Pi is still working', async () => {
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl', target: 2 });
    const sweep = sweepWith({
      entries: [turn],
      // One of the two owed replies has landed: the run is mid-flight, and
      // closing it here would destroy exactly the work this all exists for.
      sessions: { '/r/a.jsonl': sessionWithAssistantTurns(1) },
    });

    await expect(sweep.run()).resolves.toBe(0);

    expect(sweep.kill).not.toHaveBeenCalled();
    expect(sweep.forget).not.toHaveBeenCalled();
  });

  it('keeps the record when the file cannot be read, so the next connection retries', async () => {
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/gone.jsonl' });
    const sweep = sweepWith({ entries: [turn], sessions: {} });

    await expect(sweep.run()).resolves.toBe(0);

    expect(sweep.kill).not.toHaveBeenCalled();
    expect(sweep.forget).not.toHaveBeenCalled();
  });

  it('does not let a failed kill drop the record', async () => {
    const turn = record({ sessionName: 'ps-pi-a', sessionFile: '/r/a.jsonl' });
    const sweep = sweepWith({
      entries: [turn],
      sessions: { '/r/a.jsonl': sessionWithAssistantTurns(1) },
    });
    sweep.kill.mockRejectedValueOnce(new Error('ssh gone'));

    // Nothing was closed, so nothing is reported as closed.
    await expect(sweep.run()).resolves.toBe(0);

    // The kill never happened, so the record has to survive for the retry.
    expect(sweep.forget).not.toHaveBeenCalled();
  });

  it('does nothing at all without a host', async () => {
    const list = vi.fn(async () => [record()]);
    const kill = vi.fn(async () => undefined);

    await expect(
      sweepAnsweredTurns({
        host: null,
        list,
        readSession: async () => sessionWithAssistantTurns(1),
        kill,
        forget: async () => undefined,
      }),
    ).resolves.toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});
