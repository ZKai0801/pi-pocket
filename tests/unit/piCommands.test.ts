import { describe, expect, it } from 'vitest';
import {
  encodePiCwd,
  listSessionDirsCommand,
  listSessionFilesCommand,
  piNodeGlobProbeCommand,
  piListModelsCommand,
  piOverrideProbeCommand,
  piPathProbeCommand,
  quoteShell,
  readProjectCwdCommand,
  readSessionTailCommand,
} from '../../src/pi/piCommands';

describe('pi commands', () => {
  it('encodePiCwd: matches the observed dir names', () => {
    expect(encodePiCwd('/home/kai')).toBe('--home-kai--');
    expect(encodePiCwd('/home/projects/auto_sci')).toBe('--home-projects-auto_sci--');
    expect(encodePiCwd('/home/kai/.pi')).toBe('--home-kai-.pi--');
  });

  it('quoteShell: single-quotes and escapes embedded quotes', () => {
    expect(quoteShell('/home/kai')).toBe("'/home/kai'");
    expect(quoteShell("a'b")).toBe("'a'\\''b'");
  });

  it('commands: lists session dirs under the root', () => {
    expect(listSessionDirsCommand('/root')).toBe("ls -1 -- '/root' 2>/dev/null");
  });
  it('commands: reads the first header line of any session file in a dir', () => {
    expect(readProjectCwdCommand("/r/--home-kai--"))
      .toBe('for f in \'/r/--home-kai--\'/*.jsonl; do head -n 1 "$f"; break; done 2>/dev/null');
  });
  it('commands: lists session files newest first with mtime', () => {
    expect(listSessionFilesCommand('/r/--x--'))
      .toBe("find '/r/--x--' -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn");
  });
  it('commands: tails a session file with a byte cap', () => {
    expect(readSessionTailCommand('/r/a.jsonl', 4096)).toBe("tail -c 4096 -- '/r/a.jsonl' 2>/dev/null");
  });

  it('commands: probes the override, PATH and node glob for an executable', () => {
    expect(piOverrideProbeCommand('/opt/bin/pi'))
      .toBe("test -f '/opt/bin/pi' && test -x '/opt/bin/pi' && test -s '/opt/bin/pi' && printf '%s\\n' '/opt/bin/pi'");
    expect(piPathProbeCommand())
      .toBe("p=$(command -v pi) && test -f \"$p\" && test -x \"$p\" && test -s \"$p\" && printf '%s\\n' \"$p\"");
    expect(piNodeGlobProbeCommand())
      .toBe("p=$(ls -1 /home/projects/softwares/node-*/bin/pi 2>/dev/null | head -n1) && test -f \"$p\" && test -x \"$p\" && test -s \"$p\" && printf '%s\\n' \"$p\"");
  });

  it('commands: asks for the model list in the project, stderr left intact', () => {
    // No `2>/dev/null`: pi explains a failed listing on stderr, and the picker
    // shows that text. Discarding it is why the failure was unexplainable.
    expect(piListModelsCommand('/opt/bin/pi', '/home/projects/app'))
      .toBe("cd '/home/projects/app' && '/opt/bin/pi' --list-models");
  });

  it('commands: the built-ins-only retry drops extension discovery', () => {
    // `--no-extensions` is a flag, so `--list-models` cannot take it as search.
    expect(piListModelsCommand('/opt/bin/pi', '/home/projects/app', { builtInsOnly: true }))
      .toBe("cd '/home/projects/app' && '/opt/bin/pi' --no-extensions --list-models");
  });
});
