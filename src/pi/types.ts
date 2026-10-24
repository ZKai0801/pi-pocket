export interface PiTurn {
  role: 'user' | 'assistant';
  text: string;
  timestampMs: number;
}

export interface ParsedPiSession {
  version: number | null;
  id: string | null;
  cwd: string | null;
  name: string | null;
  turns: PiTurn[];
  /**
   * Whether the file's last message entry is an assistant message with no
   * outstanding tool calls — the only tail state a finished run can leave.
   * Pi appends each message the moment it is produced, an assistant's text
   * before the tool calls in that same message run, so a text turn appearing
   * in the file does NOT mean the run answered; the tail does. `undefined`
   * (a parse that saw no message entries, or a cached parse from before this
   * field existed) must be read as "not settled".
   */
  settled?: boolean;
}
