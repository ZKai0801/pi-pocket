import type { PiTransport } from './piRepository';
import {
  piNodeGlobProbeCommand,
  piOverrideProbeCommand,
  piPathProbeCommand,
} from './piCommands';
import { t } from '../i18n';

const PROBE_TIMEOUT_MS = 15000;

const PI_COMMAND_ERROR =
  t('pi.notFound');

const PI_COMMAND_WHITESPACE_ERROR =
  t('pi.argsRejected');

const PI_COMMAND_RELATIVE_ERROR =
  t('pi.relativePath');

export type PiCommandResolution =
  | { ok: true; command: string }
  | { ok: false; error: string };

export async function resolvePiCommand(
  transport: PiTransport,
  override?: string,
): Promise<PiCommandResolution> {
  const probes: string[] = [];
  if (override !== undefined) {
    if (/\s/.test(override)) return { ok: false, error: PI_COMMAND_WHITESPACE_ERROR };
    if (!override.startsWith('/')) return { ok: false, error: PI_COMMAND_RELATIVE_ERROR };
    probes.push(piOverrideProbeCommand(override));
  }
  probes.push(piPathProbeCommand(), piNodeGlobProbeCommand());

  for (const probe of probes) {
    const result = await transport.exec(probe, PROBE_TIMEOUT_MS);
    const command = result.stdout.trim();
    if (result.exitCode === 0 && command !== '') return { ok: true, command };
  }
  return { ok: false, error: PI_COMMAND_ERROR };
}
