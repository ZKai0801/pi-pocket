import { describe, expect, it } from 'vitest';
import {
  countPrompts,
  createConsoleTracker,
  isPiReady,
  PI_PROMPT_MARKER,
} from '../../src/pi/turnReadiness';

describe('pi turn readiness', () => {
  it('counts prompt markers in console text', () => {
    expect(countPrompts(`ready\n${PI_PROMPT_MARKER} `)).toBe(1);
    expect(countPrompts(`${PI_PROMPT_MARKER} a\n${PI_PROMPT_MARKER} b`)).toBe(2);
    expect(countPrompts('ready\n')).toBe(0);
  });

  it('is ready only after a prompt appears', () => {
    expect(isPiReady('ready\n')).toBe(false);
    expect(isPiReady(`ready\n${PI_PROMPT_MARKER} `)).toBe(true);
    expect(isPiReady(`${PI_PROMPT_MARKER} a\n${PI_PROMPT_MARKER} b`)).toBe(true);
  });

  it('collapses a redrawn prompt to a single prompt', () => {
    const tracker = createConsoleTracker();
    tracker.push(`${PI_PROMPT_MARKER} \r${PI_PROMPT_MARKER} `);
    expect(countPrompts(tracker.text())).toBe(1);
    expect(isPiReady(tracker.text())).toBe(true);
  });

  it('tracks chunks across partial output', () => {
    const tracker = createConsoleTracker();
    tracker.push(`${PI_PROMPT_MARKER} `);
    tracker.push('work');
    tracker.push(`${PI_PROMPT_MARKER} `);
    expect(countPrompts(tracker.text())).toBe(2);
  });

  it('detects a prompt wrapped in SGR colour', () => {
    const tracker = createConsoleTracker();
    tracker.push(`\x1b[32m${PI_PROMPT_MARKER}\x1b[0m `);
    expect(tracker.text()).toBe(`${PI_PROMPT_MARKER} `);
    expect(isPiReady(tracker.text())).toBe(true);
  });

  it('bounds the retained text and keeps the tail', () => {
    const tracker = createConsoleTracker();
    tracker.push('x'.repeat(50_000));
    tracker.push(`${PI_PROMPT_MARKER} `);
    const text = tracker.text();
    expect(text.length).toBeLessThan(50_000);
    expect(text.endsWith(`${PI_PROMPT_MARKER} `)).toBe(true);
    expect(isPiReady(text)).toBe(true);
  });
});
