import { describe, expect, it } from 'vitest';
import { createTerminalTextDecoder } from '../../src/phone/terminalText';

const encoded = (text: string) => new TextEncoder().encode(text);

describe('phone terminal UTF-8 stream', () => {
  it('reassembles a three-byte codepoint split across two PTY chunks', () => {
    const decoder = createTerminalTextDecoder();
    const bytes = encoded('中');
    expect(decoder.decode(bytes.slice(0, 1))).toBe('');
    expect(decoder.decode(bytes.slice(1))).toBe('中');
  });

  it('reassembles a four-byte codepoint split 2+2 across PTY chunks', () => {
    const decoder = createTerminalTextDecoder();
    const bytes = encoded('🙂');
    expect(decoder.decode(bytes.slice(0, 2))).toBe('');
    expect(decoder.decode(bytes.slice(2))).toBe('🙂');
  });

  it('keeps a multibyte character intact between ASCII chunks', () => {
    const decoder = createTerminalTextDecoder();
    const bytes = encoded('a中b');
    const first = decoder.decode(bytes.slice(0, 2));
    const second = decoder.decode(bytes.slice(2));
    expect(first + second).toBe('a中b');
  });

  it('drops a half-decoded codepoint when the stream resets for a new session', () => {
    const decoder = createTerminalTextDecoder();
    const bytes = encoded('中');
    expect(decoder.decode(bytes.slice(0, 1))).toBe('');
    decoder.reset();
    expect(decoder.decode(bytes)).toBe('中');
  });
});
