export interface PiTurn {
  role: 'user' | 'assistant';
  text: string;
  timestampMs: number;
  /**
   * The run's assistant replies, one per loop iteration, in file order: pi
   * writes each response the moment it is produced, so a run that narrates,
   * works, and answers leaves several. One bubble per segment is what keeps a
   * reader able to tell the iterations apart; `text` stays the whole run
   * joined (preview, counts, and every other consumer keep their merged
   * meaning). Absent on user turns and on parses from before the field
   * existed — read both as "one bubble, all of `text`".
   */
  segments?: string[];
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
  /**
   * Why the model stopped, as pi recorded it on the file's last assistant
   * message (`stop`, `toolUse`, `length`, `error`, `aborted`, ...). Pi's agent
   * loop asks the model for one more response for every reason but the ones
   * that end a run, so a settled tail is only proof the run is over when this
   * says it stopped for good. `undefined` — a file whose assistant messages
   * record no reason, or a parse from before this field existed — must be read
   * as "the file does not say", which leaves the tail as the only evidence.
   */
  stopReason?: string;
  /**
   * How many entries the parse read, of every type. A reader that watches the
   * file compares this between reads: pi appends an entry before it waits to
   * continue a run (the `context_edit` that omits the attempt it is about to
   * retry), so a count that has not moved is how a watcher tells "pi gave up"
   * from "pi is working up to the next entry".
   */
  entryCount?: number;
}
