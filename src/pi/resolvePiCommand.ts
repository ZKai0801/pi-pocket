import type { PiTransport } from './piRepository';
import {
  piNodeGlobProbeCommand,
  piOverrideProbeCommand,
  piPathProbeCommand,
} from './piCommands';

const PROBE_TIMEOUT_MS = 15000;

const PI_COMMAND_ERROR =
  '未找到可执行的 pi：请在连接编辑器的「Pi 命令」字段设置可执行文件的完整路径，或留空以自动探测。';

const PI_COMMAND_WHITESPACE_ERROR =
  '「Pi 命令」只能填写可执行文件路径，不能包含空格或参数——请在连接编辑器的「Pi 命令」字段设置单个路径，例如 /usr/local/bin/pi。';

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
