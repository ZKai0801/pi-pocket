import { describe, expect, it } from 'vitest';
import type { PiTransport } from '../../src/pi/piRepository';
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
    const { transport } = fake({ stdout: '/opt/bin/pi\n', exitCode: 0 });
    const r = await resolvePiCommand(transport, '/opt/bin/pi');
    expect(r).toEqual({ ok: true, command: '/opt/bin/pi' });
  });

  it('accepts an override only when it is executable', async () => {
    const { transport } = fake({ stdout: '', exitCode: 1 });
    const r = await resolvePiCommand(transport, '/opt/bin/pi');
    expect(r.ok).toBe(false);
  });

  it('falls back to command -v pi', async () => {
    const { transport } = fake({ stdout: '/usr/local/bin/pi\n', exitCode: 0 });
    const r = await resolvePiCommand(transport);
    expect(r).toEqual({ ok: true, command: '/usr/local/bin/pi' });
  });

  it('falls back to the node bin glob when pi is not on PATH', async () => {
    const { transport } = fake(
      { stdout: '', exitCode: 1 },
      { stdout: '/home/projects/softwares/node-v25.2.1-linux-x64/bin/pi\n', exitCode: 0 },
    );
    const r = await resolvePiCommand(transport);
    expect(r).toEqual({ ok: true, command: '/home/projects/softwares/node-v25.2.1-linux-x64/bin/pi' });
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
    expect(r.ok === false && r.error).toMatch(/pi .*(not found|设置|set)/i);
    expect(calls).toEqual([]);
  });
});
