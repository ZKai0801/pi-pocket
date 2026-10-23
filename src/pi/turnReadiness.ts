/**
 * Pi's TUI enables bracketed paste (`ESC [ ? 2004 h`) as it takes over the
 * terminal and mounts its input editor. That handshake, not a prompt glyph, is
 * the readiness signal: the pi build this app targets (1.3.0) paints a
 * full-screen editor with no `›` anywhere in its console output, so a
 * glyph-based check waits out the readiness timeout while the composer sits
 * ready on screen. Verified against the target host: the sequence arrives with
 * the first frame (~3 s), and a message written right after it starts a
 * session.
 *
 * The tracker keeps this control sequence (`cleanConsoleText` strips SGR only),
 * so `isPiReady(tracker.text())` can see it.
 */
export const PI_INPUT_READY_MARKER = '\x1b[?2004h';

const MAX_TRACKED_TEXT = 8192;

function cleanConsoleText(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const overwrite = line.lastIndexOf('\r');
      return overwrite === -1 ? line : line.slice(overwrite + 1);
    })
    .join('\n');
}

export function createConsoleTracker(): { push(chunk: string): void; text(): string } {
  let retained = '';
  return {
    push(chunk: string): void {
      retained = (retained + chunk).slice(-MAX_TRACKED_TEXT);
    },
    text(): string {
      return cleanConsoleText(retained);
    },
  };
}

/** Ready once Pi's TUI has taken over the terminal and mounted its editor. */
export function isPiReady(consoleText: string): boolean {
  return consoleText.includes(PI_INPUT_READY_MARKER);
}
