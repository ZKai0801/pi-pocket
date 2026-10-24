import { describe, expect, it } from 'vitest';
import { parsePiSession, sessionPreview } from '../../src/pi/parsePiSession';

const header = '{"type":"session","version":3,"id":"s1","timestamp":"2026-10-18T01:52:19.726Z","cwd":"/home/kai"}';
const user = '{"type":"message","id":"u1","parentId":"s1","timestamp":"2026-10-18T01:52:32.023Z","message":{"role":"user","content":[{"type":"text","text":"look at ninfer"}],"timestamp":1792288352007}}';
const assistantThinking = '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-10-18T01:52:36.042Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"toolCall","id":"c1","name":"bash","arguments":{}}],"timestamp":1792288352099}}';
const toolResult = '{"type":"message","id":"t1","parentId":"a1","timestamp":"2026-10-18T01:52:36.358Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"lots of output"}],"isError":false}}';
const assistantText = '{"type":"message","id":"a2","parentId":"t1","timestamp":"2026-10-18T01:52:40.896Z","message":{"role":"assistant","content":[{"type":"text","text":"ninfer is busy."}],"timestamp":1792288356896}}';
const sessionInfo = '{"type":"session_info","id":"n1","parentId":"a2","timestamp":"2026-10-18T01:52:41.000Z","name":"ninfer-check"}';

describe('parsePiSession', () => {
  it('reads the header and session name', () => {
    const parsed = parsePiSession([header, user, assistantText, sessionInfo].join('\n'));
    expect(parsed.version).toBe(3);
    expect(parsed.cwd).toBe('/home/kai');
    expect(parsed.name).toBe('ninfer-check');
  });

  it('keeps user text and assistant text, and groups a turn', () => {
    const parsed = parsePiSession([header, user, assistantThinking, toolResult, assistantText].join('\n'));
    expect(parsed.turns).toEqual([
      { role: 'user', text: 'look at ninfer', timestampMs: 1792288352007 },
      { role: 'assistant', text: 'ninfer is busy.', timestampMs: 1792288356896 },
    ]);
  });

  it('drops a thinking/tool-only assistant turn', () => {
    const parsed = parsePiSession([header, user, assistantThinking, toolResult].join('\n'));
    expect(parsed.turns.map((t) => t.role)).toEqual(['user']);
  });

  it('accepts a plain-string content', () => {
    const stringUser = '{"type":"message","id":"u2","parentId":"s1","timestamp":"2026-10-18T01:53:00.000Z","message":{"role":"user","content":"hi","timestamp":1792288380000}}';
    const parsed = parsePiSession([header, stringUser].join('\n'));
    expect(parsed.turns).toEqual([{ role: 'user', text: 'hi', timestampMs: 1792288380000 }]);
  });

  it('ignores a truncated trailing line', () => {
    const parsed = parsePiSession([header, user, '{"type":"message","id":"x","par'].join('\n'));
    expect(parsed.turns).toEqual([{ role: 'user', text: 'look at ninfer', timestampMs: 1792288352007 }]);
  });

  it('returns an empty result for empty input', () => {
    expect(parsePiSession('')).toEqual({
      version: null,
      id: null,
      cwd: null,
      name: null,
      turns: [],
      modelSwitches: [],
      model: null,
      settled: false,
    });
  });

  it('previews the last assistant turn', () => {
    expect(sessionPreview(parsePiSession([header, user, assistantText].join('\n')))).toBe('ninfer is busy.');
    expect(sessionPreview(parsePiSession(''))).toBeNull();
  });

  it('separates assistant text fragments across tool round-trips with a newline', () => {
    const multiUser = '{"type":"message","id":"mu","parentId":"s1","timestamp":"2026-10-18T02:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"check the build"}],"timestamp":1792288400001}}';
    const roundTripText1 = '{"type":"message","id":"r1","parentId":"mu","timestamp":"2026-10-18T02:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"I\'ll check."},{"type":"text","text":"One moment."}],"timestamp":1792288401001}}';
    const roundTripTool = '{"type":"message","id":"rt","parentId":"r1","timestamp":"2026-10-18T02:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c9","name":"bash","arguments":{}}],"timestamp":1792288402001}}';
    const roundTripResult = '{"type":"message","id":"rr","parentId":"rt","timestamp":"2026-10-18T02:00:03.000Z","message":{"role":"toolResult","toolCallId":"c9","toolName":"bash","content":[{"type":"text","text":"busy"}],"isError":false}}';
    const roundTripText2 = '{"type":"message","id":"r2","parentId":"rr","timestamp":"2026-10-18T02:00:04.000Z","message":{"role":"assistant","content":[{"type":"text","text":"It\'s busy."}],"timestamp":1792288404001}}';
    const finalAssistant = '{"type":"message","id":"r3","parentId":"r2","timestamp":"2026-10-18T02:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"All done."}],"timestamp":1792288405001}}';

    const parsed = parsePiSession(
      [header, multiUser, roundTripText1, roundTripTool, roundTripResult, roundTripText2, finalAssistant].join('\n'),
    );
    const assistantTurns = parsed.turns.filter((turn) => turn.role === 'assistant');
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0].text).toBe("I'll check.\nOne moment.\nIt's busy.\nAll done.");
    expect(assistantTurns[0].text).not.toContain('check.One');
    expect(assistantTurns[0].timestampMs).toBe(1792288405001);
  });

  // The settled cases live flat in this one describe block: the unit gate's
  // manifest registers exactly one suite per file, so nesting would hide them.
  it('settled: is false while the last assistant message still owes tool work', () => {
    // The narration text is already in the file, but the tool call in the
    // same message has not run: pi appends text before it works, so only
    // the tail separates this from a finished run.
    const parsed = parsePiSession(
      [header, user, assistantText, assistantThinking].join('\n'),
    );
    expect(parsed.settled).toBe(false);
  });

  it('settled: is false while a tool result is the last message entry', () => {
    const parsed = parsePiSession([header, user, assistantThinking, toolResult].join('\n'));
    expect(parsed.settled).toBe(false);
  });

  it('settled: is false when a user message is the last entry', () => {
    const parsed = parsePiSession([header, user].join('\n'));
    expect(parsed.settled).toBe(false);
  });

  it('settled: is true when the last message is an assistant answer without tool calls', () => {
    const parsed = parsePiSession([header, user, assistantThinking, toolResult, assistantText].join('\n'));
    expect(parsed.settled).toBe(true);
  });

  it('settled: is true for a thinking-only final message, as nothing is left to run', () => {
    const thinkingOnly = '{"type":"message","id":"a9","parentId":"u1","timestamp":"2026-10-18T01:52:41.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"done"}],"timestamp":1792288357000}}';
    const parsed = parsePiSession([header, user, thinkingOnly].join('\n'));
    expect(parsed.settled).toBe(true);
  });

  it('settled: ignores non-message entries after the final answer', () => {
    const parsed = parsePiSession([header, user, assistantText, sessionInfo].join('\n'));
    expect(parsed.settled).toBe(true);
  });

  it('settled: tracks the tail across a multi-round run', () => {
      const multiUser = '{"type":"message","id":"mu","parentId":"s1","timestamp":"2026-10-18T02:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"check the build"}],"timestamp":1792288400001}}';
      const roundTripText1 = '{"type":"message","id":"r1","parentId":"mu","timestamp":"2026-10-18T02:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"I\'ll check."}],"timestamp":1792288401001}}';
      const roundTripTool = '{"type":"message","id":"rt","parentId":"r1","timestamp":"2026-10-18T02:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c9","name":"bash","arguments":{}}],"timestamp":1792288402001}}';
      const roundTripResult = '{"type":"message","id":"rr","parentId":"rt","timestamp":"2026-10-18T02:00:03.000Z","message":{"role":"toolResult","toolCallId":"c9","toolName":"bash","content":[{"type":"text","text":"busy"}],"isError":false}}';
      const finalAssistant = '{"type":"message","id":"r3","parentId":"rr","timestamp":"2026-10-18T02:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"All done."}],"timestamp":1792288405001}}';

      const midRun = parsePiSession(
        [header, multiUser, roundTripText1, roundTripTool].join('\n'),
      );
      expect(midRun.settled).toBe(false);

      const toolsDone = parsePiSession(
        [header, multiUser, roundTripText1, roundTripTool, roundTripResult].join('\n'),
      );
      expect(toolsDone.settled).toBe(false);

      const finished = parsePiSession(
        [header, multiUser, roundTripText1, roundTripTool, roundTripResult, finalAssistant].join('\n'),
      );
      expect(finished.settled).toBe(true);
  });

  // ---- model_change -----------------------------------------------------
  //
  // Pi appends a `model_change` entry for every `/model`, so the divider a
  // chat draws between its turns comes from the file — including switches
  // made in a terminal this app never sees.

  const modelChange = '{"type":"model_change","id":"m1","parentId":"a2","timestamp":"2026-10-18T01:53:00.000Z","provider":"openai","modelId":"gpt-5"}';
  const secondChange = '{"type":"model_change","id":"m2","parentId":"u2","timestamp":"2026-10-18T01:54:00.000Z","provider":"anthropic","modelId":"claude-opus-4-5"}';
  const thirdChange = '{"type":"model_change","id":"m3","parentId":"u3","timestamp":"2026-10-18T01:55:00.000Z","provider":"google","modelId":"gemini-3-pro"}';
  const user2 = '{"type":"message","id":"u2","parentId":"m1","timestamp":"2026-10-18T01:53:30.000Z","message":{"role":"user","content":[{"type":"text","text":"and now?"}],"timestamp":1792288410000}}';
  const assistantWithModel = '{"type":"message","id":"am","parentId":"u1","timestamp":"2026-10-18T01:52:40.896Z","message":{"role":"assistant","provider":"anthropic","model":"claude-opus-4-5","content":[{"type":"text","text":"ninfer is busy."}],"timestamp":1792288356896}}';

  it('records a model_change as a switch between the turns it belongs between', () => {
    const parsed = parsePiSession([header, user, modelChange, user2].join('\n'));

    expect(parsed.turns.map((turn) => turn.text)).toEqual(['look at ninfer', 'and now?']);
    expect(parsed.modelSwitches).toEqual([
      {
        from: null,
        to: 'openai/gpt-5',
        timestampMs: Date.parse('2026-10-18T01:53:00.000Z'),
        afterTurns: 1,
      },
    ]);
  });

  it('carries the previous switch into the next one as its "from"', () => {
    const parsed = parsePiSession([header, user, modelChange, user2, secondChange].join('\n'));

    expect(parsed.modelSwitches?.map((item) => [item.from, item.to])).toEqual([
      [null, 'openai/gpt-5'],
      ['openai/gpt-5', 'anthropic/claude-opus-4-5'],
    ]);
  });

  it('takes the first switch\'s "from" from the model on an earlier assistant message', () => {
    const parsed = parsePiSession([header, user, assistantWithModel, modelChange, user2].join('\n'));

    expect(parsed.modelSwitches).toEqual([
      {
        from: 'anthropic/claude-opus-4-5',
        to: 'openai/gpt-5',
        timestampMs: Date.parse('2026-10-18T01:53:00.000Z'),
        afterTurns: 2,
      },
    ]);
  });

  it('places a switch after the assistant turn the file had already produced', () => {
    // The switch sits between the assistant answer and the next user message;
    // the assistant turn only becomes a turn at the next user entry, so the
    // divider's position is the count the file held AFTER that turn stood.
    const parsed = parsePiSession([header, user, assistantText, modelChange, user2].join('\n'));

    expect(parsed.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
    expect(parsed.modelSwitches?.[0]?.afterTurns).toBe(2);
  });

  it('ignores a model_change that names no model', () => {
    const empty = '{"type":"model_change","id":"m9","parentId":"a2","timestamp":"2026-10-18T01:53:00.000Z"}';
    const parsed = parsePiSession([header, user, empty, user2].join('\n'));

    expect(parsed.turns.map((turn) => turn.text)).toEqual(['look at ninfer', 'and now?']);
    expect(parsed.modelSwitches).toEqual([]);
  });

  it('does not count a switch as a turn or unsettle the run', () => {
    const parsed = parsePiSession([header, user, assistantText, modelChange].join('\n'));

    expect(parsed.turns).toHaveLength(2);
    expect(parsed.settled).toBe(true);
    expect(parsed.modelSwitches).toHaveLength(1);
  });

  // ---- model in effect ---------------------------------------------------
  //
  // The header names the model answering, which is the one the walk ends on:
  // the last switch's target, or the model the session's first assistant
  // message named when the file records no switch.

  it('names the model the first assistant message was produced by', () => {
    const parsed = parsePiSession([header, user, assistantWithModel].join('\n'));

    expect(parsed.model).toBe('anthropic/claude-opus-4-5');
  });

  it('ends on the last switch\'s target, not the model the session began with', () => {
    const user3 = '{"type":"message","id":"u3","parentId":"m2","timestamp":"2026-10-18T01:54:30.000Z","message":{"role":"user","content":[{"type":"text","text":"again?"}],"timestamp":1792288470000}}';
    const parsed = parsePiSession(
      [header, user, assistantWithModel, modelChange, user2, secondChange, user3, thirdChange].join('\n'),
    );

    expect(parsed.model).toBe('google/gemini-3-pro');
  });

  it('leaves the model null when the file never says which one is in effect', () => {
    const parsed = parsePiSession([header, user, assistantText].join('\n'));

    expect(parsed.model).toBeNull();
  });
});
