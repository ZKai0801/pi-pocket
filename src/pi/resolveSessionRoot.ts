import type { PiTransport } from './piRepository';
import { candidateSessionRoots } from './sessionRoot';
import { resolveSessionRootCommand, sessionsRootHasFilesCommand } from './piCommands';

const PROBE_TIMEOUT_MS = 15000;

/**
 * The first candidate that answers `probe`, or null when none does. A failed
 * exec counts as a "no": the next candidate may still be reachable, and an
 * unreachable one cannot be the root the app can use.
 */
async function firstAnswering(
  transport: PiTransport,
  roots: readonly string[],
  probe: (root: string) => string,
): Promise<string | null> {
  for (const root of roots) {
    const result = await transport.exec(probe(root), PROBE_TIMEOUT_MS);
    if (result.stdout.trim() === 'yes') return root;
  }
  return null;
}

/**
 * Resolve the session root among the candidates, in two passes:
 *
 * 1. The first candidate with pi's session-file shape (`*.jsonl` one encoded
 *    directory down). This is the pass that protects a wrong session-dir
 *    override: an agent directory or a bare `~/.pi` exists, passes a plain
 *    `-d` test, and then lists zero sessions — the exact silence that reads
 *    as “no projects on this host”.
 * 2. The first candidate that merely exists, unchanged from the original
 *    single-pass behaviour, so an unusual-but-real layout this build cannot
 *    recognise still resolves instead of failing outright.
 */
export async function resolveSessionRoot(
  transport: PiTransport,
  home: string,
  env: Record<string, string | undefined>,
  override?: string,
): Promise<string | null> {
  const roots = candidateSessionRoots(home, env, override);
  const shaped = await firstAnswering(transport, roots, sessionsRootHasFilesCommand);
  if (shaped !== null) return shaped;
  return firstAnswering(transport, roots, resolveSessionRootCommand);
}
