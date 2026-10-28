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
 * the conversation's file and the assistant-turn count that means "answered"
 * — the same count, from the same parser, that the runner itself settles on,
 * backed by the same settled-tail test — so the reconciliation closes only
 * runs that are provably finished. A run that is still working has not reached
 * that count or still owes tool work, and is never killed: killing it would
 * destroy exactly the work this app keeps alive across a disconnect. Instead
 * it is reported back as `running`, so the store can take the watch over again
 * — rule 1 of this file is that the watcher dies with the app, and rule 2 is
 * that the turn does not.
 *
 * These records are a cache, not the truth. They live in the phone's storage,
 * so a reinstall, a "clear data", or a turn delivered from another device
 * leaves none behind, while the agent keeps working in its pane. The
 * authority is the host's own tmux server: `liveTurns.ts` lists the sessions
 * that are alive and matches each to its file, and `reconcilePendingTurns`
 * treats that listing as the candidate set whenever it is available. Records
 * then only supply what a name cannot say — the count a steering turn settled
 * on — and a record naming a session the host does not have is retired.
 *
 * A record whose tmux session is gone is neither: the agent exited without its
 * reply ever landing, so there is nothing to watch and nothing to kill, and the
 * record is dropped so the chat stops claiming a turn is running in a pane
 * that no longer exists.
 *
 * Keyed by host and session name: the name is what tmux needs, the host is
 * where it lives. A record is overwritten when the same conversation's next
 * turn starts, so a stale one can never outlive the session it describes, and
 * the store is bounded by a TTL and a cap so it cannot grow forever.
 */
import type { ParsedPiSession } from './types';
import type { LiveTurn } from './liveTurns';

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
 * The stop reasons that end a pi run.
 *
 * Pi records on every assistant message why the model stopped, and its agent
 * loop asks for one more response for all but these: `toolUse` means the tool
 * calls in that very message still have to run, and `length`/`error` are
 * recovered by a retry, a compaction, or a continuation. `pending`/`deferred`
 * are not finished responses at all. So a tail that looks finished is not
 * proof: a narrating model's text is in the file seconds into a run, and an
 * errored turn's is in it while pi waits to retry — settling there is what
 * killed turns mid-flight.
 */
const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set(['stop', 'aborted']);

/**
 * Whether pi's loop asks the model for another response after this message —
 * the reading a watcher has to make before it calls a run over.
 *
 * `undefined` (a file whose assistant messages record no reason, or a parse
 * from before the field existed) is read the way the tail alone always was:
 * the file does not say, so the tail is the only evidence there is.
 */
export function isFinalStopReason(stopReason: string | undefined): boolean {
  return stopReason === undefined || TERMINAL_STOP_REASONS.has(stopReason);
}

/**
 * Whether a run has actually been answered: the assistant-turn count the run
 * itself settled on, AND a session file whose last message entry is an
 * assistant message with no outstanding tool calls (`settled`), AND a last
 * assistant message that stopped for good.
 *
 * The count alone is not enough: pi appends each assistant message the moment
 * it is produced — its text lands in the file before the tool calls in that
 * same message run — so a narrating model reaches the target count seconds
 * into a run that is still working. Reading the count as "answered" there is
 * what killed turns mid-flight.
 *
 * Nor is the tail alone: the same file shape — an assistant message with
 * nothing left to run — is what a turn that failed leaves while pi waits out
 * its retry backoff and asks again.
 */
export function isRunAnswered(session: ParsedPiSession, target: number): boolean {
  return (
    countAssistantTurns(session) >= target &&
    session.settled === true &&
    isFinalStopReason(session.stopReason)
  );
}

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
  /**
   * Every turn session alive on the host, with the file it is writing
   * (`liveTurns.ts`). This — not the records — is the authority on what is
   * running: a reinstall or a data clear leaves no record behind while the
   * agent keeps working, and a record can outlive the pane it describes.
   *
   * `null`, `undefined` or absent means the host could not be asked; the
   * records are then the only candidates, exactly as before.
   */
  liveTurns?: readonly LiveTurn[] | null;
  /** The same full read the runner polls, so the count means the same thing. */
  readSession(path: string): Promise<ParsedPiSession>;
  /** Close the conversation's tmux session. Best-effort by contract. */
  kill(sessionName: string): Promise<void>;
  /**
   * Whether a record's tmux session still exists — used only on the
   * records-only path, where no live listing was available. Absent, or a
   * probe that fails, means "cannot tell": the record is kept for the next
   * sweep instead of being dropped. Only a session that is provably gone
   * retires a record.
   */
  hasSession?(sessionName: string): Promise<boolean>;
  forget(host: string, sessionName: string): Promise<void>;
}

/**
 * A turn that is still in flight, with the parse that proves it.
 *
 * `target` comes from the record when there is one, because a turn that took
 * steering has more than one owed reply. Without a record the file's own count
 * is the only baseline there is, and it is sound: reaching it is what the tail
 * already says, so the answer test there reduces to "the run is at rest".
 */
export interface LiveTurnRun {
  sessionName: string;
  sessionFile: string;
  target: number;
  session: ParsedPiSession;
}

/**
 * What one pass over the host found. The caller acts on the last group: a turn
 * that is still running is one to watch again, not one to close — that is the
 * whole point of the records surviving the app.
 */
export interface PendingTurnSettlement {
  /** Sessions closed because their turn had been answered. */
  closed: number;
  /** Turns still owing work: take the watch over. */
  running: LiveTurnRun[];
  /** Records dropped because their tmux session no longer exists. */
  gone: number;
  /** Records kept because nothing could be read; the next pass retries. */
  unreadable: number;
}

/**
 * Reconcile the host's live turn sessions — and the records of turns this
 * phone delivered — with what has actually been answered.
 *
 * Live sessions are the candidate set when the host can list them, so a turn
 * nobody recorded here — a reinstall, a cleared store, another device — is
 * still found and watched. A live session whose file is at rest and which a
 * record names is closed (the reply landed while the phone was not looking, and
 * nobody is left to tear the pane down); one that still owes work is handed
 * back to be watched; and a record naming a session the host does not have is
 * dropped, because a pane that no longer exists can neither be watched nor
 * killed. A session this phone never delivered is never killed: an at-rest file
 * on such a pane cannot distinguish a finished turn from one the agent has not
 * started writing yet, and guessing wrong there destroys work.
 *
 * The read is the only authority on "answered": a file that cannot be read
 * leaves its turn for the next pass, and a count below the target means Pi is
 * still working.
 */
export async function reconcilePendingTurns(
  deps: PendingTurnSweepDeps,
): Promise<PendingTurnSettlement> {
  const settlement: PendingTurnSettlement = {
    closed: 0,
    running: [],
    gone: 0,
    unreadable: 0,
  };
  // No host means no connection was reached: there is nothing to read, and a
  // record must not be acted on through some other host's transport.
  if (deps.host === null || deps.host === '') return settlement;
  const records = await deps.list(deps.host).catch(() => []);

  interface Candidate {
    sessionName: string;
    sessionFile: string;
    /** The recorded count, or null when the turn was never recorded here. */
    target: number | null;
    /**
     * Whether this phone delivered the turn. Only a delivered turn is one this
     * app may tear down: a session it merely found is a pane whose line nobody
     * here sent, and an at-rest file cannot tell "pi finished that turn" from
     * "pi had not started it yet" — a kill on that guess would destroy work.
     */
    delivered: boolean;
  }
  const candidates: Candidate[] = [];
  const live = deps.liveTurns ?? null;
  if (live === null) {
    for (const record of records) {
      candidates.push({
        sessionName: record.sessionName,
        sessionFile: record.sessionFile,
        target: record.target,
        delivered: true,
      });
    }
  } else {
    const bySession = new Map(records.map((record) => [record.sessionName, record]));
    const liveNames = new Set(live.map((turn) => turn.sessionName));
    for (const record of records) {
      if (liveNames.has(record.sessionName)) continue;
      await deps.forget(record.host, record.sessionName).catch(() => undefined);
      settlement.gone += 1;
    }
    for (const turn of live) {
      const recorded = bySession.get(turn.sessionName);
      candidates.push({
        sessionName: turn.sessionName,
        sessionFile: turn.sessionFile,
        target: recorded?.target ?? null,
        delivered: recorded !== undefined,
      });
    }
  }

  for (const candidate of candidates) {
    let session: ParsedPiSession;
    try {
      session = await deps.readSession(candidate.sessionFile);
    } catch {
      settlement.unreadable += 1;
      continue;
    }
    const target = candidate.target ?? countAssistantTurns(session);
    if (isRunAnswered(session, target)) {
      // A turn this phone did not deliver has no teardown owed here — and no
      // way to tell an idle pane from one Pi is about to write into.
      if (!candidate.delivered) continue;
      try {
        await deps.kill(candidate.sessionName);
      } catch {
        // The kill never landed, so the session is probably still there: keep
        // the record rather than forget a cleanup that still has to happen.
        settlement.unreadable += 1;
        continue;
      }
      await deps.forget(deps.host, candidate.sessionName).catch(() => undefined);
      settlement.closed += 1;
      continue;
    }
    // Still working — unless the pane it works in is gone, in which case the
    // agent died before its reply landed and no watcher can ever be joined in.
    // Only the records-only path has to ask: a listed session exists by
    // definition.
    if (live === null && deps.hasSession !== undefined) {
      let alive: boolean | null;
      try {
        alive = await deps.hasSession(candidate.sessionName);
      } catch {
        alive = null;
      }
      if (alive === false) {
        await deps.forget(deps.host, candidate.sessionName).catch(() => undefined);
        settlement.gone += 1;
        continue;
      }
      if (alive === null) {
        settlement.unreadable += 1;
        continue;
      }
    }
    settlement.running.push({
      sessionName: candidate.sessionName,
      sessionFile: candidate.sessionFile,
      target,
      session,
    });
  }
  return settlement;
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
