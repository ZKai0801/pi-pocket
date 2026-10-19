import { describe, expect, it } from 'vitest';
import type { PiTransport } from '../../src/pi/piRepository';
import {
  piNodeGlobProbeCommand,
  piOverrideProbeCommand,
  piPathProbeCommand,
} from '../../src/pi/piCommands';
import { resolvePiCommand } from '../../src/pi/resolvePiCommand';

type ExecResult = { stdout: string; exitCode: number };

function fake(...responses: ExecResult[]) {
  const queue = responses.length > 0 ? responses : [{ stdout: '', exitCode: 1 }];
  const calls: string[] = [];
  let index = 0;
  const transport: PiTransport = {
    async exec(command) {
      calls.push(command);
      const next = queue[Math.min(index, queue.length - 1)];
      index += 1;
      return { stdout: next.stdout, stderr: '', exitCode: next.exitCode };
    },
    async sftpRead() {
      return '';
    },
  };
  return { transport, calls };
}

describe('resolvePiCommand', () => {
  it('prefers a working per-host override', async () => {
    const { transport, calls } = fake(
      { stdout: '/opt/bin/pi\n', exitCode: 0 },
      { stdout: '/usr/bin/pi\n', exitCode: 0 },
      { stdout: '/node/bin/pi\n', exitCode: 0 },
    );
    const r = await resolvePiCommand(transport, '/opt/bin/pi');
    expect(r).toEqual({ ok: true, command: '/opt/bin/pi' });
    expect(calls[0]).toBe(piOverrideProbeCommand('/opt/bin/pi'));
    expect(calls).toHaveLength(1);
  });

  it('falls through a set-but-invalid override to a PATH hit', async () => {
    const { transport, calls } = fake(
      { stdout: '', exitCode: 1 },
      { stdout: '/usr/bin/pi\n', exitCode: 0 },
      { stdout: '/node/bin/pi\n', exitCode: 0 },
    );
    const r = await resolvePiCommand(transport, '/opt/bin/pi');
    expect(r).toEqual({ ok: true, command: '/usr/bin/pi' });
    expect(calls[0]).toBe(piOverrideProbeCommand('/opt/bin/pi'));
    expect(calls[1]).toBe(piPathProbeCommand());
  });

  it('treats a nonzero exit with non-empty stdout as a miss', async () => {
    const { transport } = fake(
      { stdout: '/opt/bin/pi\n', exitCode: 1 },
      { stdout: '/usr/bin/pi\n', exitCode: 0 },
      { stdout: '/node/bin/pi\n', exitCode: 0 },
    );
    const r = await resolvePiCommand(transport, '/opt/bin/pi');
    expect(r).toEqual({ ok: true, command: '/usr/bin/pi' });
  });

  it('falls back to command -v pi', async () => {
    const { transport, calls } = fake(
      { stdout: '/usr/bin/pi\n', exitCode: 0 },
      { stdout: '/node/bin/pi\n', exitCode: 0 },
    );
    const r = await resolvePiCommand(transport);
    expect(r).toEqual({ ok: true, command: '/usr/bin/pi' });
    expect(calls[0]).toBe(piPathProbeCommand());
  });

  it('falls back to the node bin glob when pi is not on PATH', async () => {
    const { transport, calls } = fake(
      { stdout: '', exitCode: 1 },
      { stdout: '/node/bin/pi\n', exitCode: 0 },
    );
    const r = await resolvePiCommand(transport);
    expect(r).toEqual({ ok: true, command: '/node/bin/pi' });
    expect(calls[0]).toBe(piPathProbeCommand());
    expect(calls[1]).toBe(piNodeGlobProbeCommand());
  });

  it('fails with an actionable error when nothing is found', async () => {
    const { transport } = fake({ stdout: '', exitCode: 1 });
    const r = await resolvePiCommand(transport);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/pi .*(not found|设置|set)/i);
  });

  it('rejects an override containing whitespace without probing', async () => {
    const { transport, calls } = fake({ stdout: '/opt/bin/pi\n', exitCode: 0 });
    const r = await resolvePiCommand(transport, '/opt/bin/pi --flag');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('空格');
    expect(r.ok === false && r.error).toContain('参数');
    expect(calls).toEqual([]);
  });
});
