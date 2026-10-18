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
});
