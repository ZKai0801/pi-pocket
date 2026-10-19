import { describe, expect, it, vi } from 'vitest';
import type { ParsedPiSession } from '../../src/pi/types';
import { createSessionsStore } from '../../src/stores/sessions';

const session: ParsedPiSession = {
  version: 3,
  id: 'a',
  cwd: '/p/a',
  name: null,
  turns: [{ role: 'user', text: 'hi', timestampMs: 1 }],
};

function deps() {
  return {
    listSessions: vi.fn(async () => []),
    readSession: vi.fn(async () => session),
  };
}

describe('sessions store project switch', () => {
  it('clears the open chat when a different project is loaded', async () => {
    const store = createSessionsStore(deps() as never);
    await store.load({ path: '/p/a', name: 'a' });
    await store.openSession('/r/a.jsonl');
    expect(store.open).not.toBeNull();

    await store.load({ path: '/p/b', name: 'b' });
    expect(store.open).toBeNull();
    expect(store.openPath).toBeNull();
    expect(store.lastProject?.path).toBe('/p/b');
  });

  it('keeps the open chat when the same project is reloaded', async () => {
    const store = createSessionsStore(deps() as never);
    await store.load({ path: '/p/a', name: 'a' });
    await store.openSession('/r/a.jsonl');
    await store.load({ path: '/p/a', name: 'a' });
    expect(store.open).not.toBeNull();
    expect(store.openPath).toBe('/r/a.jsonl');
  });

  it('drops an open from the previous project that resolves after the switch', async () => {
    let resolveRead: ((session: ParsedPiSession) => void) | undefined;
    const read = new Promise<ParsedPiSession>((resolve) => { resolveRead = resolve; });
    const d = {
      listSessions: vi.fn(async () => []),
      readSession: vi.fn(() => read),
    };
    const store = createSessionsStore(d as never);
    await store.load({ path: '/p/a', name: 'a' });

    const pending = store.openSession('/r/a.jsonl');
    await store.load({ path: '/p/b', name: 'b' });
    resolveRead?.(session);
    await pending;

    expect(store.open).toBeNull();
    expect(store.openPath).toBeNull();
    expect(store.lastProject?.path).toBe('/p/b');
  });
});
