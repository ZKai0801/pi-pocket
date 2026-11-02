import { describe, expect, it } from 'vitest';
import {
  cpuPercentFromStatLines,
  formatKibibytes,
  formatLoad,
  formatMegabytes,
  formatPercent,
  formatUptime,
  parseAmdRow,
  parseHostMetrics,
  parseLoadAvg,
  parseMemInfo,
  parseNvidiaRow,
  parseProcessRow,
} from '../../src/host/hostMetrics';

/** A Linux host with both GPUs answering and three busy processes. */
const FULL_SAMPLE = [
  'LOAD 0.52 0.38 0.21 2/345 6789',
  'CORES 8',
  'CPU1 cpu  4705 187 1204 151263 642 0 234 0 0 0',
  'CPU2 cpu  4730 190 1210 151268 643 0 235 0 0 0',
  'MEM MemTotal: 32078956 kB MemAvailable: 18500000 kB SwapTotal: 4095996 kB SwapFree: 4000000 kB',
  'UP 152345.67 120000.00',
  'GPU 0, NVIDIA GeForce RTX 4090, 87, 12345, 24576, 71, 320.55',
  'GPU 1, NVIDIA A100-SXM4-80GB, 0, 0, 81920, 35, [N/A]',
  'PROC 4521 99.0 5.2 alexey node',
  'PROC 900 12.5 1.0 alexey Web Content',
  'PROC 1 0.0 0.1 root systemd',
].join('\n');

/**
 * Reading one sample.
 *
 * The class this has to cover is "the host answered something other than what
 * the happy path prints": a BSD box with no `/proc`, a driver that reports
 * `[Not Supported]` in a numeric column, a `ps` that prints a header anyway, a
 * BusyBox `sort` that left the rows unsorted, and a command name that contains
 * spaces. Each one is a real host shape, and each one must degrade to an honest
 * dash rather than to a zero.
 */
describe('Parsing a host metrics sample', () => {
  it('reads a complete Linux sample with two GPUs', () => {
    const snapshot = parseHostMetrics(FULL_SAMPLE, 1_000);
    expect(snapshot.capturedAt).toBe(1_000);
    expect(snapshot.procReadable).toBe(true);
    expect(snapshot.cpu).toEqual({
      usedPercent: 85.4,
      coreCount: 8,
      load1: 0.52,
      load5: 0.38,
      load15: 0.21,
    });
    expect(snapshot.memory.totalKb).toBe(32_078_956);
    expect(snapshot.memory.usedKb).toBe(13_578_956);
    expect(snapshot.memory.usedPercent).toBe(42.3);
    expect(snapshot.memory.swapUsedKb).toBe(95_996);
    expect(snapshot.uptimeSeconds).toBeCloseTo(152_345.67, 2);
    expect(snapshot.gpus).toHaveLength(2);
    expect(snapshot.gpus[0]).toEqual({
      vendor: 'nvidia',
      name: 'NVIDIA GeForce RTX 4090',
      utilPercent: 87,
      memoryUsedMb: 12_345,
      memoryTotalMb: 24_576,
      temperatureC: 71,
      powerDrawW: 320.55,
    });
  });

  it('counts the processes down by CPU, whatever order the host sent them in', () => {
    const scrambled = [
      'PROC 1 0.0 0.1 root systemd',
      'PROC 4521 99.0 5.2 alexey node',
      'PROC 900 12.5 1.0 alexey Web Content',
    ].join('\n');
    const snapshot = parseHostMetrics(scrambled, 0);
    expect(snapshot.processes.map((row) => row.command)).toEqual(['node', 'Web Content', 'systemd']);
    expect(snapshot.procReadable).toBe(false);
  });

  it('excludes idle and iowait from the busy window and rounds to a tenth', () => {
    const before = 'cpu  100 0 0 800 100 0 0 0 0 0';
    const after = 'cpu  150 0 0 850 100 0 0 0 0 0';
    // 50 of a 100-tick window is busy, and the iowait field is not idle here.
    expect(cpuPercentFromStatLines(before, after)).toBe(50);
  });

  it('has no reading at all when the window advanced by nothing', () => {
    const line = 'cpu  100 0 0 800 0 0 0 0 0 0';
    expect(cpuPercentFromStatLines(line, line)).toBeNull();
  });

  it('has no reading when a counter went backwards, instead of claiming 0%', () => {
    expect(cpuPercentFromStatLines('cpu  500 0 0 500 0 0 0 0 0 0', 'cpu  100 0 0 500 0 0 0 0 0 0')).toBeNull();
  });

  it('refuses to invent a percentage from a missing or malformed stat line', () => {
    const good = 'cpu  100 0 0 800 0 0 0 0 0 0';
    expect(cpuPercentFromStatLines(undefined, good)).toBeNull();
    expect(cpuPercentFromStatLines(good, undefined)).toBeNull();
    expect(cpuPercentFromStatLines('cpu0 1 2 3 4 5', 'cpu  10 10 10 10 10')).toBeNull();
    expect(cpuPercentFromStatLines('not a stat line', 'not a stat line')).toBeNull();
    // A 32-bit counter that overflowed into fewer fields than its partner.
    expect(cpuPercentFromStatLines('cpu  1 1 1 1', 'cpu  2 2 2 2 2')).toBeNull();
  });

  it('reads a whole window of idle as a real zero, not as a missing value', () => {
    const before = 'cpu  0 0 0 100 0 0 0 0 0 0';
    const after = 'cpu  0 0 0 200 0 0 0 0 0 0';
    expect(cpuPercentFromStatLines(before, after)).toBe(0);
    expect(formatPercent(cpuPercentFromStatLines(before, after))).toBe('0%');
  });

  it('takes the GPU numbers from the end so a comma in the model name is harmless', () => {
    const gpu = parseNvidiaRow('0, NVIDIA GeForce RTX 4090 (rev, 1), 87, 12345, 24576, 71, 320.55');
    expect(gpu).not.toBeNull();
    expect(gpu?.name).toBe('NVIDIA GeForce RTX 4090 (rev, 1)');
    expect(gpu?.utilPercent).toBe(87);
    expect(gpu?.memoryTotalMb).toBe(24_576);
    expect(gpu?.powerDrawW).toBe(320.55);
  });

  it('reads a driver that answers [N/A] or [Not Supported] as no value', () => {
    const gpu = parseNvidiaRow('0, Tesla T4, [Not Supported], 100, 15360, [Not Supported], [N/A]');
    expect(gpu?.utilPercent).toBeNull();
    expect(gpu?.temperatureC).toBeNull();
    expect(gpu?.powerDrawW).toBeNull();
    expect(gpu?.memoryUsedMb).toBe(100);
  });

  it('drops a GPU row that is too short to be one', () => {
    expect(parseNvidiaRow('0, Tesla T4')).toBeNull();
    expect(parseNvidiaRow('')).toBeNull();
  });

  it('reads an AMD card from sysfs as utilisation only, named after its path', () => {
    const gpu = parseAmdRow('45 /sys/class/drm/card1/device/gpu_busy_percent');
    expect(gpu).toEqual({
      vendor: 'amd',
      name: 'AMD card1',
      utilPercent: 45,
      memoryUsedMb: null,
      memoryTotalMb: null,
      temperatureC: null,
      powerDrawW: null,
    });
    expect(parseAmdRow('not-a-number /sys/class/drm/card0/device/gpu_busy_percent')).toBeNull();
  });

  it('keeps a command name that contains spaces, and drops a header row', () => {
    expect(parseProcessRow('900 12.5 1.0 alexey Web Content')?.command).toBe('Web Content');
    expect(parseProcessRow('PID %CPU %MEM USER COMMAND')?.pid).toBeUndefined();
    expect(parseProcessRow('PID %CPU %MEM USER COMMAND')).toBeNull();
    expect(parseProcessRow('1 0.0')).toBeNull();
    expect(parseProcessRow('0 1.0 1.0 root x')).toBeNull();
  });

  it('reads a host with no /proc as unreadable rather than as idle', () => {
    const snapshot = parseHostMetrics('CORES 0\nPROC 1 0.0 0.0 root sh', 5);
    expect(snapshot.procReadable).toBe(false);
    expect(snapshot.cpu.usedPercent).toBeNull();
    expect(snapshot.cpu.coreCount).toBeNull();
    expect(snapshot.memory.totalKb).toBeNull();
    expect(snapshot.memory.usedPercent).toBeNull();
    expect(snapshot.uptimeSeconds).toBeNull();
    expect(snapshot.gpus).toEqual([]);
    expect(snapshot.processes).toHaveLength(1);
  });

  it('ignores blank lines, unknown lines and a host that printed nothing', () => {
    const noise = '\n\nbash: cannot set terminal process group\nrandom text here\n';
    expect(parseHostMetrics(noise, 0).procReadable).toBe(false);
    expect(parseHostMetrics('', 0).processes).toEqual([]);
    const stillGood = parseHostMetrics(`${noise}${FULL_SAMPLE}`, 0);
    expect(stillGood.procReadable).toBe(true);
    expect(stillGood.cpu.usedPercent).toBe(85.4);
  });

  it('parses each section independently, so one broken line costs only its field', () => {
    const broken = [
      'LOAD - - x',
      'CORES eight',
      'CPU1 cpu  a b c d',
      'CPU2 cpu  a b c d',
      'MEM MemTotal: kB',
      'UP not-a-number',
      'GPU 0, only, three',
    ].join('\n');
    const snapshot = parseHostMetrics(broken, 0);
    expect(snapshot.cpu).toEqual({ usedPercent: null, coreCount: null, load1: null, load5: null, load15: null });
    expect(snapshot.memory.totalKb).toBeNull();
    expect(snapshot.uptimeSeconds).toBeNull();
    expect(snapshot.gpus).toEqual([]);
    expect(snapshot.procReadable).toBe(true);
  });

  it('reads a load average and a meminfo line on their own', () => {
    expect(parseLoadAvg('1.00 2.00 3.00 1/1 1')).toEqual({ load1: 1, load5: 2, load15: 3 });
    expect(parseLoadAvg(undefined)).toEqual({ load1: null, load5: null, load15: null });
    expect(parseMemInfo('SwapTotal: 0 kB SwapFree: 0 kB').swapTotalKb).toBe(0);
    expect(parseMemInfo('').usedPercent).toBeNull();
  });

  it('draws a missing figure as a dash and a real zero as zero', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(42.4)).toBe('42%');
    expect(formatLoad(null)).toBe('—');
    expect(formatLoad(0)).toBe('0.00');
    expect(formatKibibytes(null)).toBe('—');
    expect(formatKibibytes(-1)).toBe('—');
    expect(formatKibibytes(13_578_956)).toBe('12.9 GiB');
    expect(formatKibibytes(32_078_956)).toBe('30.6 GiB');
    expect(formatKibibytes(4_194_304)).toBe('4 GiB');
    expect(formatKibibytes(134_217_728)).toBe('128 GiB');
    expect(formatKibibytes(95_996)).toBe('94 MiB');
    expect(formatUptime(null)).toBe('—');
    expect(formatUptime(152_345)).toBe('1d 18h');
    expect(formatUptime(3_720)).toBe('1h 2m');
    expect(formatUptime(420)).toBe('7m');
  });

  it('labels video memory in the GiB a card is sold as', () => {
    expect(formatMegabytes(null)).toBe('—');
    // `nvidia-smi` reports a 24 GB card as 24576/24576 minus what is in use.
    expect(formatMegabytes(24_576)).toBe('24 GiB');
    expect(formatMegabytes(12_345)).toBe('12.1 GiB');
    expect(formatMegabytes(512)).toBe('512 MiB');
    expect(formatMegabytes(0)).toBe('0 MiB');
  });
});
