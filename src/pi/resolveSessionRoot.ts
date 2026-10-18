import type { PiTransport } from './piRepository';
import { candidateSessionRoots } from './sessionRoot';
import { resolveSessionRootCommand } from './piCommands';

const PROBE_TIMEOUT_MS = 15000;

export async function resolveSessionRoot(
  transport: PiTransport,
  home: string,
  env: Record<string, string | undefined>,
  override?: string,
): Promise<string | null> {
  for (const root of candidateSessionRoots(home, env, override)) {
    const probe = await transport.exec(resolveSessionRootCommand(root), PROBE_TIMEOUT_MS);
    if (probe.stdout.trim() === 'yes') return root;
  }
  return null;
}
