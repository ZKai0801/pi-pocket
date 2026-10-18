import { describe, expect, it } from 'vitest';
import {
  encodePiCwd,
  listSessionDirsCommand,
  listSessionFilesCommand,
  quoteShell,
  readProjectCwdCommand,
  readSessionTailCommand,
} from '../../src/pi/piCommands';

describe('encodePiCwd', () => {
  it('matches the observed dir names', () => {
    expect(encodePiCwd('/home/kai')).toBe('--home-kai--');
    expect(encodePiCwd('/home/projects/auto_sci')).toBe('--home-projects-auto_sci--');
    expect(encodePiCwd('/home/kai/.pi')).toBe('--home-kai-.pi--');
  });
});

describe('quoteShell', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(quoteShell('/home/kai')).toBe("'/home/kai'");
    expect(quoteShell("a'b")).toBe("'a'\\''b'");
  });
});

describe('commands', () => {
  it('lists session dirs under the root', () => {
    expect(listSessionDirsCommand('/root')).toBe("ls -1 -- '/root' 2>/dev/null");
  });
  it('reads the first header line of any session file in a dir', () => {
    expect(readProjectCwdCommand("/r/--home-kai--"))
      .toBe('for f in \'/r/--home-kai--\'/*.jsonl; do head -n 1 "$f"; break; done 2>/dev/null');
  });
  it('lists session files newest first with mtime', () => {
    expect(listSessionFilesCommand('/r/--x--'))
      .toBe("find '/r/--x--' -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn");
  });
  it('tails a session file with a byte cap', () => {
    expect(readSessionTailCommand('/r/a.jsonl', 4096)).toBe("tail -c 4096 -- '/r/a.jsonl' 2>/dev/null");
  });
});
