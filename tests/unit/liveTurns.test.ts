import { describe, expect, it } from 'vitest';
import {
  matchTurnSessionFiles,
  parseTurnSessionNames,
  type LiveTurn,
} from '../../src/pi/liveTurns';
import {
  PI_TURN_LIST_END,
  PI_TURN_LIST_MISSING,
  turnSessionNameForFile,
} from '../../src/pi/piTurn';

/**
 * Two paths whose names collide. A 32-bit hash over a few thousand session
 * files will eventually produce one, and this pair is a real collision found
 * by brute force — the point is that the match cannot resolve it, and picking
 * either file would mean watching, or killing, a conversation nobody asked
 * about. The assertion below re-checks the collision, so a change to the name
 * function surfaces here instead of as a silently dead branch.
 */
const COLLIDING: readonly [string, string] = ['/r/x/0k4.jsonl', '/r/x/jke3orzha.jsonl'];

function names(...values: string[]): string {
  return [...values, PI_TURN_LIST_END].join('\n');
}

// One top-level describe for the whole file: the unit gate's manifest registers
// exactly one suite per file.
describe('live turns', () => {
  it('parseTurnSessionNames: reads the listed turns and drops everything that is not one', () => {
    const listed = [
      names('ps-pi-abc12', 'ps-pi-draft-abc12-xy', 'someone-elses-session'),
      '',
    ].join('\n');

    expect(parseTurnSessionNames(listed)).toEqual(['ps-pi-abc12']);
  });

  it('parseTurnSessionNames: distinguishes "nothing is running" from "the host did not answer"', () => {
    // No sessions left is an answer: every stored record is then cleanable.
    expect(parseTurnSessionNames(`${PI_TURN_LIST_END}\n`)).toEqual([]);
    // A listing that never ran says nothing at all — a killed channel, output
    // truncated mid-flight — and must not be read as "nothing is running".
    expect(parseTurnSessionNames('ps-pi-abc12\n')).toBeNull();
    expect(parseTurnSessionNames('')).toBeNull();
    // A host without tmux cannot have turn sessions, but it also cannot report
    // about the ones that might have existed before tmux went missing.
    expect(parseTurnSessionNames(`${PI_TURN_LIST_MISSING}\n`)).toBeNull();
  });

  it('matchTurnSessionFiles: maps a live name back to the file it was named after', () => {
    const file = '/r/--home-kai-project--/abc.jsonl';

    expect(matchTurnSessionFiles([turnSessionNameForFile(file)], [file, '/r/other/x.jsonl'])).toEqual([
      { sessionName: turnSessionNameForFile(file), sessionFile: file },
    ]);
  });

  it('matchTurnSessionFiles: drops a name no file produces and a name two files produce', () => {
    const file = '/r/--home-kai-project--/abc.jsonl';
    const [first, second] = COLLIDING;
    // Both files claim one name: the match has to drop it rather than choose.
    expect(turnSessionNameForFile(first)).toBe(turnSessionNameForFile(second));
    const ambiguous = turnSessionNameForFile(first);

    const matched: LiveTurn[] = matchTurnSessionFiles(
      [turnSessionNameForFile(file), 'ps-pi-unmatched', ambiguous],
      [file, first, second],
    );

    expect(matched).toEqual([{ sessionName: turnSessionNameForFile(file), sessionFile: file }]);
  });
});
