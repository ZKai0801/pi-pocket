export interface PiTurn {
  role: 'user' | 'assistant';
  text: string;
  timestampMs: number;
}

/**
 * One `model_change` entry of a session file: pi appends it whenever the
 * active model is switched, whether the switch came from this chat's `/model`
 * or from a terminal the app never sees. The entry names only the model the
 * change SELECTED — never the one it replaced — so `from` is reconstructed
 * while walking the file (the previous switch's target, or the model on an
 * earlier assistant message).
 */
export interface PiModelSwitch {
  /** The model now in effect, as pi names it: `provider/modelId`. */
  to: string;
  /** The model it replaced, when the file says so; null when it does not. */
  from: string | null;
  /** When the change was appended; 0 when the entry carried no readable time. */
  timestampMs: number;
  /**
   * How many conversation turns the file held when the change was appended:
   * the divider belongs between turn `afterTurns - 1` and turn `afterTurns`
   * (`afterTurns === turns.length` closes the transcript).
   */
  afterTurns: number;
}

export interface ParsedPiSession {
  version: number | null;
  id: string | null;
  cwd: string | null;
  name: string | null;
  turns: PiTurn[];
  /**
   * Model switches the file records, in file order. Absent in a parse from
   * before the field existed (or in a hand-built session): read it as "no
   * switches recorded".
   */
  modelSwitches?: PiModelSwitch[];
  /**
   * The model in effect at the end of the file, as pi names it: the target of
   * the last `model_change`, or the model on the session's first assistant
   * message. Null when the file never said — a session that records no switch
   * and whose messages name no model. Absent in a parse from before the field
   * existed (or in a hand-built session): read it as "unknown".
   */
  model?: string | null;
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
