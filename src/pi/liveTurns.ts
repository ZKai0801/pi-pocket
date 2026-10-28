/**
 * Which turns are still running on the host — asked of the host, not of the
 * phone's own storage.
 *
 * A delivered turn is written down locally (`pendingTurns.ts`) so a connection
 * can find it again, but that record is a cache of intent, not the truth: it
 * lives in the phone's storage and a reinstall, a "clear data", a different
 * device, or a storage failure wipes it, while the agent itself keeps working
 * in its tmux session on the host (D44). So the run state is read from the
 * authority: the private tmux server lists the turns that are alive, and each
 * one is matched back to the conversation file it is writing.
 *
 * ## Why the match is a hash of every candidate
 *
 * A session name is `ps-pi-<fnv1a(file)>` — derivable from a file, not
 * invertible back to one. The listing therefore comes with the full set of
 * session files (`listTurnSessionFilesCommand`) and each name is matched by
 * recomputing the hash. The set is flat (pi stores conversations one `--cwd--`
 * directory below the root), so this is a directory walk and a few dozen
 * thousand string hashes, once per connection and once per watch tick.
 *
 * Two things cannot be matched and are deliberately dropped rather than
 * guessed: a **draft** turn, whose name is random by design (it has no file to
 * be named by), and a name two files produce (a 32-bit hash collision, where
 * picking either one would mean watching, or killing, the wrong conversation).
 */
import { PI_TURN_LIST_END, PI_TURN_LIST_MISSING, turnSessionNameForFile } from './piTurn';

/** A turn session alive on the host, and the conversation file it writes. */
export interface LiveTurn {
  sessionName: string;
  sessionFile: string;
}

/**
 * The turn sessions the host listed, or `null` when the host could not be
 * asked.
 *
 * `null` is not "nothing is running": it is "unknown", and the caller has to
 * fall back to whatever it knows locally instead of treating every stored
 * record as dead.
 */
export function parseTurnSessionNames(stdout: string): string[] | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.includes(PI_TURN_LIST_MISSING)) return null;
  // No end marker means the listing never ran — a killed connection, a shell
  // that could not reach tmux, output truncated mid-flight.
  if (!lines.includes(PI_TURN_LIST_END)) return null;
  return lines.filter((line) => line !== PI_TURN_LIST_END && isTurnSessionName(line));
}

/**
 * `ps-pi-<hash>` — a real conversation's turn. A draft is `ps-pi-draft-…` and
 * is excluded: it names no file, so nothing could be watched through it.
 */
function isTurnSessionName(name: string): boolean {
  return name.startsWith('ps-pi-') && !name.startsWith('ps-pi-draft-');
}

/**
 * Match the host's live session names to the files under the session root.
 * A name with no file, or with two, is dropped: an unmatched session is one
 * this app can neither read nor join, and a collision cannot be resolved
 * without guessing.
 */
export function matchTurnSessionFiles(
  names: readonly string[],
  files: readonly string[],
): LiveTurn[] {
  // `null` marks a name two files produce, so a collision can never resolve to
  // whichever file happened to be walked last.
  const byName = new Map<string, string | null>();
  for (const file of files) {
    const name = turnSessionNameForFile(file);
    byName.set(name, byName.has(name) ? null : file);
  }
  const live: LiveTurn[] = [];
  for (const name of names) {
    const file = byName.get(name);
    if (file === undefined || file === null) continue;
    live.push({ sessionName: name, sessionFile: file });
  }
  return live;
}
