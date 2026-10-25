/**
 * The chat-only cut's standing guard (spec 2026-10-25): the phone app builds
 * no aplexer (`a …`) or host-CLI (`pocketshell …`) command and imports none
 * of core's terminal/usage host surfaces. Dev-mode mocks are included — the
 * mock must model the product, not the deleted surfaces.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|vue)$/.test(name) ? [path] : [];
  });
}

const COMMAND_PATTERNS: [RegExp, string][] = [
  [/pocketshell\s+(sessions|usage|repos|hooks|status|--version)/, 'host-CLI command'],
  [/(^|[^\w.@'`/-])a\s+(start|attach|kill|snapshot|watch)\b/, 'aplexer command'],
  [/(^|[^\w.@'`/-])a\s+list\s+--/, 'aplexer command'],
];

const IDENTIFIERS = [
  'hostCliSessions', 'usageSource', 'agentLaunch', 'buildAttachCommand',
  'aplexerAttachCommand', 'aplexerStartCommand', 'aplexerSnapshotCommand',
  'aplexerKillCommand', 'aplexerProbeCommand', 'subscribeTerminalOutput',
];

describe('no host-CLI surface in the phone app', () => {
  it('src/ builds no a/pocketshell commands and uses no host-CLI modules', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, label] of COMMAND_PATTERNS) {
        const match = text.match(pattern);
        if (match) offenders.push(`${file}: ${label} "${match[0].trim()}"`);
      }
      for (const identifier of IDENTIFIERS) {
        if (text.includes(identifier)) offenders.push(`${file}: identifier ${identifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
