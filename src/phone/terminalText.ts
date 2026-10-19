/**
 * Incremental UTF-8 decoding for the one PTY stream the phone shell shows.
 *
 * A PTY chunk can end in the middle of a codepoint (a three-byte CJK
 * character or a four-byte emoji split across two reads). Decoding each chunk
 * on its own turns the split halves into U+FFFD; `stream: true` keeps the
 * incomplete tail in the decoder until the rest arrives. A new session must
 * not inherit that tail, so `reset()` throws the decoder away.
 */
export interface TerminalTextDecoder {
  /** Decode the next chunk, carrying an incomplete codepoint into the next call. */
  decode(bytes: Uint8Array): string;
  /** Start a new stream: drop any half-decoded codepoint. */
  reset(): void;
}

export function createTerminalTextDecoder(): TerminalTextDecoder {
  let decoder = new TextDecoder();
  return {
    decode(bytes) {
      return decoder.decode(bytes, { stream: true });
    },
    reset() {
      decoder = new TextDecoder();
    },
  };
}
