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
    expect(parsePiSession('')).toEqual({ version: null, id: null, cwd: null, name: null, turns: [] });
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
});
