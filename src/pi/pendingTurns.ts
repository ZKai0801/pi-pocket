/**
 * Turns that were delivered on the host but not yet seen answered.
 *
 * A turn runs in a tmux session on the host (`piTurn.ts`), and whoever watches
 * it is also the one that kills it: the runner tears the session down the
 * moment the reply lands, because an idle Pi in a session nobody looks at is
 * one node process per conversation ever opened. That watcher does not always
 * survive the turn — the app can be killed, the process reaped, or the poll's
 * deadline can expire while the phone is offline (a build plus its tests
 * routinely outlives the ten-minute deadline) — and then Pi finishes in a
 * session that no one is left to close.
 *
 * So every delivered turn is written down here, and each new connection
 * rechecks the records it holds for the host it just reached. A record names
 * the conversation's file and the assistant-turn count that means "answered" —
 * the same count, from the same parser, that the runner itself settles on — so
 * the sweep closes only runs that are provably finished. A run that is still
 * working has not reached that count and is left strictly alone: killing it
 * would destroy exactly the work this app keeps alive across a disconnect.
 *
 * Keyed by host and session name: the name is what tmux needs, the host is
 * where it lives. A record is overwritten when the same conversation's next
 * turn starts, so a stale one can never outlive the session it describes, and
 * the store is bounded by a TTL and a cap so it cannot grow forever.
 */
import type { ParsedPiSession } from './types';

/** Bumped when the stored shape changes; older entries are discarded. */
export const PENDING_TURN_SCHEMA = 1;

export interface PendingTurn {
  /** The stored shape's version; a record from another build is discarded. */
  schema: number;
  /** The host the turn runs on (the store's active host name). */
  host: string;
  /** The tmux session Pi is working in; the thing a sweep closes. */
  sessionName: string;
  /** The session file whose assistant turns prove the run was answered. */
  sessionFile: string;
  /**
   * Assistant turns that mean "answered" — the run's own target, including
   * one more for every steering or follow-up message that joined it.
   */
  target: number;
  /** When the run was recorded; the TTL and eviction order are measured from here. */
  startedAtMs: number;
}

export interface PendingTurnKey {
  host: string;
  sessionName: string;
}

export interface PendingTurnStorage {
  all(): Promise<PendingTurn[]>;
  put(entry: PendingTurn): Promise<void>;
  delete(key: PendingTurnKey): Promise<void>;
}

export interface PendingTurnPolicy {
  /**
   * How long a record can still lead to a cleanup. A record is only useful
   * while its turn might plausibly still be that same turn; a day comfortably
   * outlives the longest turn deadline, and past it the session is either gone
   * or the user has moved on.
   */
  ttlMs: number;
  /** Hard cap on remembered turns, oldest dropped first. */
  maxTurns: number;
}

export const DEFAULT_PENDING_TURN_POLICY: PendingTurnPolicy = {
  ttlMs: 24 * 60 * 60 * 1000,
  maxTurns: 32,
};

/**
 * The count a record's `target` is compared against: one per assistant turn,
 * where consecutive assistant entries (a reply plus its tool calls) are one
 * turn. Identical to the runner's own arithmetic — a separate definition here
 * would let the sweep disagree with the poll about what "answered" means.
 */
export function countAssistantTurns(session: ParsedPiSession): number {
  return session.turns.filter((turn) => turn.role === 'assistant').length;
}

export function isPendingTurnExpired(
  entry: PendingTurn,
  nowMs: number,
  ttlMs: number,
): boolean {
  return nowMs - entry.startedAtMs > ttlMs;
}

/** The records a sweep should delete: expired ones, then the oldest past `maxTurns`. */
export function selectPendingTurnEvictions(
  entries: readonly PendingTurn[],
  nowMs: number,
  policy: PendingTurnPolicy,
): PendingTurnKey[] {
  const key = (entry: PendingTurn): PendingTurnKey => ({
    host: entry.host,
    sessionName: entry.sessionName,
  });
  const expired = entries.filter((entry) => isPendingTurnExpired(entry, nowMs, policy.ttlMs));
  const live = entries
    .filter((entry) => !isPendingTurnExpired(entry, nowMs, policy.ttlMs))
    .sort((left, right) => right.startedAtMs - left.startedAtMs);
  return [...expired.map(key), ...live.slice(Math.max(0, policy.maxTurns)).map(key)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A record this build can still act on: current schema, usable fields. */
export function isUsablePendingTurn(value: unknown): value is PendingTurn {
  return (
    isRecord(value) &&
    value.schema === PENDING_TURN_SCHEMA &&
    typeof value.host === 'string' &&
    value.host.length > 0 &&
    typeof value.sessionName === 'string' &&
    value.sessionName.length > 0 &&
    typeof value.sessionFile === 'string' &&
    value.sessionFile.length > 0 &&
    typeof value.target === 'number' &&
    Number.isInteger(value.target) &&
    value.target >= 1 &&
    typeof value.startedAtMs === 'number' &&
    Number.isFinite(value.startedAtMs)
  );
}

export class PendingTurns {
  constructor(
    private readonly storage: PendingTurnStorage,
    private readonly policy: PendingTurnPolicy = DEFAULT_PENDING_TURN_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Remember that a turn is in flight. Called again for the same conversation
   * when a queued message raises the target, so the record always describes
   * the run as it stands.
   */
  async remember(
    host: string | null,
    turn: { sessionName: string; sessionFile: string; target: number },
  ): Promise<void> {
    if (host === null || host === '') return;
    try {
      await this.storage.put({
        schema: PENDING_TURN_SCHEMA,
        host,
        sessionName: turn.sessionName,
        sessionFile: turn.sessionFile,
        target: turn.target,
        startedAtMs: this.now(),
      });
      await this.sweep();
    } catch {
      // A store that cannot be written only loses the cleanup, never the turn.
    }
  }

  /** The run settled somewhere the phone could see: nothing left to recheck. */
  async forget(host: string | null, sessionName: string): Promise<void> {
    if (host === null || host === '') return;
    await this.storage.delete({ host, sessionName }).catch(() => undefined);
  }

  /** The records a fresh connection to `host` should recheck. Never throws. */
  async onHost(host: string | null): Promise<PendingTurn[]> {
    if (host === null || host === '') return [];
    try {
      return (await this.storage.all()).filter(
        (entry) =>
          entry.host === host &&
          isUsablePendingTurn(entry) &&
          !isPendingTurnExpired(entry, this.now(), this.policy.ttlMs),
      );
    } catch {
      return [];
    }
  }

  /** Apply the retention policy; safe to call often, cheap when nothing is due. */
  async sweep(): Promise<void> {
    try {
      const entries = await this.storage.all();
      for (const key of selectPendingTurnEvictions(entries, this.now(), this.policy)) {
        await this.storage.delete(key);
      }
    } catch {
      // A sweep that cannot read the store leaves it as it was.
    }
  }
}

export interface PendingTurnSweepDeps {
  /** The host the connection just reached; nothing is checked without one. */
  host: string | null;
  list(host: string): Promise<PendingTurn[]>;
  /** The same full read the runner polls, so the count means the same thing. */
  readSession(path: string): Promise<ParsedPiSession>;
  /** Close the conversation's tmux session. Best-effort by contract. */
  kill(sessionName: string): Promise<void>;
  forget(host: string, sessionName: string): Promise<void>;
}

/**
 * Close the tmux sessions whose recorded turn has been answered, and return
 * how many were closed.
 *
 * The read is the only authority: a file that cannot be read leaves its record
 * in place for the next connection, and a count below the target means Pi is
 * still working — the record stays so a later connection can finish the job.
 */
export async function sweepAnsweredTurns(deps: PendingTurnSweepDeps): Promise<number> {
  // No host means no connection was reached: there is nothing to read, and a
  // record must not be acted on through some other host's transport.
  if (deps.host === null || deps.host === '') return 0;
  const turns = await deps.list(deps.host).catch(() => []);
  let closed = 0;
  for (const turn of turns) {
    let answered = false;
    try {
      answered = countAssistantTurns(await deps.readSession(turn.sessionFile)) >= turn.target;
    } catch {
      continue;
    }
    if (!answered) continue;
    try {
      await deps.kill(turn.sessionName);
    } catch {
      // The kill never landed, so the session is probably still there: keep
      // the record rather than forget a cleanup that still has to happen.
      continue;
    }
    await deps.forget(turn.host, turn.sessionName).catch(() => undefined);
    closed += 1;
  }
  return closed;
}

/** In-memory storage: tests, and any environment without localStorage. */
export function createMemoryPendingTurnStorage(): PendingTurnStorage {
  const entries = new Map<string, PendingTurn>();

  function idOf(key: PendingTurnKey): string {
    return `${key.host}\n${key.sessionName}`;
  }

  return {
    async all() {
      return [...entries.values()];
    },
    async put(entry) {
      entries.set(idOf(entry), entry);
    },
    async delete(key) {
      entries.delete(idOf(key));
    },
  };
}

/** The single localStorage key holding every host's pending turns as one record. */
export const PENDING_TURNS_STORAGE_KEY = 'pocketshell.android.pi.pendingTurns.v1';

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): KeyValueStorage | null {
  try {
    const storage = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/**
 * The phone's durable storage. A record is four short fields, so localStorage
 * holds it like the list backups do — and it has to be durable: the case this
 * exists for is the app being killed mid-turn, so an in-memory record would be
 * gone exactly when the sweep needs it.
 */
export function createLocalPendingTurnStorage(
  storage: KeyValueStorage | null = browserStorage(),
): PendingTurnStorage | null {
  if (!storage) return null;
  const backing: KeyValueStorage = storage;

  function read(): PendingTurn[] {
    let raw: string | null = null;
    try {
      raw = backing.getItem(PENDING_TURNS_STORAGE_KEY);
    } catch {
      return [];
    }
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUsablePendingTurn);
  }

  function write(entries: readonly PendingTurn[]): void {
    try {
      if (entries.length === 0) backing.removeItem(PENDING_TURNS_STORAGE_KEY);
      else backing.setItem(PENDING_TURNS_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // A full or read-only store degrades to no cleanup, never to an error.
    }
  }

  function idOf(key: PendingTurnKey): string {
    return `${key.host}\n${key.sessionName}`;
  }

  return {
    async all() {
      return read();
    },
    async put(entry) {
      const key = idOf(entry);
      write([...read().filter((existing) => idOf(existing) !== key), entry]);
    },
    async delete(key) {
      const id = idOf(key);
      write(read().filter((existing) => idOf(existing) !== id));
    },
  };
}

let installedStore: PendingTurns | null = null;

/** The process-wide store: localStorage where available, memory otherwise. */
export function pendingTurns(): PendingTurns {
  if (installedStore === null) {
    installedStore = new PendingTurns(
      createLocalPendingTurnStorage() ?? createMemoryPendingTurnStorage(),
    );
  }
  return installedStore;
}

/** Test seam: replace (or, with null, reset) the process-wide store. */
export function installPendingTurns(store: PendingTurns | null): void {
  installedStore = store;
}
