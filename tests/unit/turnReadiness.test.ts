import { describe, expect, it } from 'vitest';
import {
  createConsoleTracker,
  isPiReady,
  PI_INPUT_READY_MARKER,
} from '../../src/pi/turnReadiness';

/**
 * The head of a real pi 1.3.0 frame on the target host, trimmed to the bytes
 * that matter: alternate screen, bracketed paste, the painted footer. Note the
 * absence of any `›`; the old glyph-based check never fired against it.
 */
const PI_13_FIRST_FRAME =
  '\x1b[?1049h\x1b[?7l\x1b[?2004h\x1b[>7u\x1b[2J\x1b[H\x1b[?25l'
  + '\x1b[38;5;102m0.0%/131k (auto)\x1b[39m'
  + '\x1b[38;5;102mqwen3.8-27b \u2022 medium\x1b[39m';

describe('pi turn readiness', () => {
  it('is ready once pi announces its interactive editor', () => {
    expect(isPiReady(PI_13_FIRST_FRAME)).toBe(true);
    expect(isPiReady(PI_INPUT_READY_MARKER)).toBe(true);
  });

  it('stays not-ready on startup output before the editor handshake', () => {
    expect(isPiReady('')).toBe(false);
    expect(isPiReady('Pi\nLoading extensions...\n')).toBe(false);
    expect(isPiReady('\x1b[?1049h\x1b[2J\x1b[H')).toBe(false);
  });

  it('does not mistake a prompt glyph for readiness', () => {
    // A `›` in rendered console text (a tool result, a help line) is not the
    // editor handshake; counting it was the bug that timed every send out.
    expect(isPiReady('\u203a ready')).toBe(false);
  });

  it('keeps the handshake visible through SGR colour and redraws', () => {
    expect(isPiReady(`\x1b[32m${PI_INPUT_READY_MARKER}\x1b[0m`)).toBe(true);
    expect(isPiReady(`\x1b[2J\r${PI_INPUT_READY_MARKER}`)).toBe(true);
  });

  it('tracks chunks across partial output', () => {
    const tracker = createConsoleTracker();
    tracker.push('\x1b[?10');
    expect(isPiReady(tracker.text())).toBe(false);
    tracker.push('49h\x1b[2J');
    expect(isPiReady(tracker.text())).toBe(false);
    tracker.push(`${PI_INPUT_READY_MARKER} composer`);
    expect(isPiReady(tracker.text())).toBe(true);
  });

  it('bounds the retained text and keeps the tail', () => {
    const tracker = createConsoleTracker();
    tracker.push('x'.repeat(50_000));
    tracker.push(PI_INPUT_READY_MARKER);
    const text = tracker.text();
    expect(text.length).toBeLessThan(50_000);
    expect(text.endsWith(PI_INPUT_READY_MARKER)).toBe(true);
    expect(isPiReady(text)).toBe(true);
  });
});
