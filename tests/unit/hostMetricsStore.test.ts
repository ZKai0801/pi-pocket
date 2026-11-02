import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { installPiLive } from '../../src/session/piLive';
import { HOST_BADGE_POLL_MS, useHostMetricsStore } from '../../src/stores/hostMetrics';
import { useConnectionsStore } from '../../src/stores/connections';
import { hostMetricsCommand } from '../../src/host/hostMetrics';

/** A Linux host that answers every section. */
const SAMPLE = [
  'LOAD 0.52 0.38 0.21 2/345 6789',
  'CORES 8',
  'CPU1 cpu  4705 187 1204 151263 642 0 234 0 0 0',
  'CPU2 cpu  4730 190 1210 151268 643 0 235 0 0 0',
  'MEM MemTotal: 32078956 kB MemAvailable: 18500000 kB SwapTotal: 4095996 kB SwapFree: 4000000 kB',
  'GPU 0, NVIDIA GeForce RTX 4090, 87, 12345, 24576, 71, 320.55',
  'PROC 4521 99.0 5.2 alexey node',
].join('\n');

/** The same host one window later, at 13 busy ticks of 19 instead of 35 of 41. */
const SAMPLE_CALMER = SAMPLE.replace('CPU2 cpu  4730', 'CPU2 cpu  4708');

interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const ok = (stdout: string): ExecOutcome => ({ stdout, stderr: '', exitCode: 0 });

/**
 * The store that owns the host numbers.
 *
 * What is held to account here is not the arithmetic — the parser's own suite
 * covers that — but the four things a user would call a bug: showing another
 * host's load, still showing a load after the host is gone, letting a slow read
 * overwrite a fast one, and spending an SSH channel on a screen nobody is
 * looking at.
 */
describe('The host metrics store', () => {
  let exec = vi.fn();
  let metrics: ReturnType<typeof useHostMetricsStore>;
  let connections: ReturnType<typeof useConnectionsStore>;

  /** A Pi seam whose exec is the test's, so the store runs on its real path. */
  function installExec(implementer: (command: string, timeoutMs: number) => Promise<ExecOutcome>): void {
    exec = vi.fn(implementer);
    installPiLive({
      transport: () => ({ exec, sftpRead: async () => '' }),
      remoteContext: async () => ({ home: '/home/alexey', env: {} }),
      listDirectories: async () => [],
    });
  }

  const succeedWith = (stdout: string = SAMPLE) => installExec(async () => ok(stdout));

  beforeEach(() => {
    setActivePinia(createPinia());
    connections = useConnectionsStore();
    connections.activeName = 'hetzner';
    connections.status = 'connected';
    metrics = useHostMetricsStore();
    metrics.reset();
    succeedWith();
  });

  afterEach(() => {
    installPiLive(null);
    vi.useRealTimers();
  });

  it('takes one sample and keeps it with the host it belongs to', async () => {
    await expect(metrics.refresh()).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith(hostMetricsCommand(), 15_000);
    expect(metrics.owner).toBe('hetzner');
    expect(metrics.snapshot?.cpu.usedPercent).toBe(85.4);
    expect(metrics.snapshot?.gpus[0]?.name).toBe('NVIDIA GeForce RTX 4090');
    expect(metrics.error).toBeNull();
    expect(metrics.loading).toBe(false);
  });

  it('refuses to sample a host that is not connected', async () => {
    connections.status = 'idle';
    await expect(metrics.refresh()).resolves.toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(metrics.error).toBe('no-connection');
    expect(metrics.snapshot).toBeNull();
  });

  it('keeps the last numbers and only reports an error when a read fails', async () => {
    await metrics.refresh();
    const before = metrics.snapshot;
    installExec(async () => {
      throw new Error('SSH exec failed');
    });
    await expect(metrics.refresh()).resolves.toBe(false);
    expect(metrics.snapshot).toBe(before);
    expect(metrics.error).toBe('transport');
    expect(metrics.loading).toBe(false);
  });

  it('reports a host that answered nothing it could read, without calling it idle', async () => {
    await metrics.refresh();
    installExec(async () => ok('bash: cannot set terminal process group\n'));
    await expect(metrics.refresh()).resolves.toBe(false);
    expect(metrics.error).toBe('unreadable');
    // The previous reading survives: it is old, but it is not wrong yet.
    expect(metrics.snapshot?.cpu.usedPercent).toBe(85.4);
  });

  it('drops the numbers the moment a different host becomes the live one', async () => {
    await metrics.refresh();
    connections.activeName = 'other-box';
    await nextTick();
    expect(metrics.snapshot).toBeNull();
    expect(metrics.owner).toBe('other-box');
    expect(metrics.error).toBeNull();
  });

  it('drops the numbers when the connection itself goes away', async () => {
    await metrics.refresh();
    connections.status = 'error';
    connections.activeName = null;
    await nextTick();
    expect(metrics.snapshot).toBeNull();
    expect(metrics.owner).toBeNull();
  });

  it('lets the newer read win when two are in flight', async () => {
    const gates: Array<(outcome: ExecOutcome) => void> = [];
    installExec(() => new Promise<ExecOutcome>((resolve) => {
      gates.push(resolve);
    }));

    const first = metrics.refresh();
    const second = metrics.refresh();
    expect(gates).toHaveLength(2);
    // The second lands first, and then the stale one arrives behind it.
    gates[1](ok(SAMPLE_CALMER));
    await second;
    gates[0](ok(SAMPLE));
    await first;
    expect(metrics.snapshot?.cpu.usedPercent).toBe(68.4);
    expect(metrics.loading).toBe(false);
    expect(metrics.error).toBeNull();
  });

  it('polls only while the badge is on screen, and only once per arming', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let calls = 0;
    installExec(async () => {
      calls += 1;
      return ok(SAMPLE);
    });

    metrics.setWatched(true, HOST_BADGE_POLL_MS);
    expect(metrics.watched).toBe(true);
    // Arming with nothing on screen samples at once instead of waiting.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    // A second arm is a no-op, not a second timer on the same channel budget.
    metrics.setWatched(true, HOST_BADGE_POLL_MS);
    await vi.advanceTimersByTimeAsync(HOST_BADGE_POLL_MS);
    expect(calls).toBe(2);

    metrics.setWatched(false);
    expect(metrics.watched).toBe(false);
    await vi.advanceTimersByTimeAsync(HOST_BADGE_POLL_MS * 3);
    expect(calls).toBe(2);
  });

  it('waits a full interval before re-sampling a reading that is still fresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    let calls = 0;
    installExec(async () => {
      calls += 1;
      return ok(SAMPLE);
    });
    metrics.setWatched(true, HOST_BADGE_POLL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(HOST_BADGE_POLL_MS - 1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
  });

  it('tears the poll and the in-flight sample both down on reset', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const gates: Array<(outcome: ExecOutcome) => void> = [];
    installExec(() => new Promise<ExecOutcome>((resolve) => {
      gates.push(resolve);
    }));
    metrics.setWatched(true, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    metrics.reset();
    expect(metrics.watched).toBe(false);
    expect(metrics.snapshot).toBeNull();
    expect(metrics.owner).toBeNull();
    // The sample that was already crossing the wire belongs to nobody now.
    gates[0]?.(ok(SAMPLE));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(metrics.snapshot).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
