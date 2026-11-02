// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HostLoadBadge from '../../src/components/host/HostLoadBadge.vue';
import HostStatusScreen from '../../src/components/host/HostStatusScreen.vue';
import { hostMetricsCommand, type HostSnapshot } from '../../src/host/hostMetrics';
import { installPiLive } from '../../src/session/piLive';
import { t } from '../../src/i18n';
import { useConnectionsStore } from '../../src/stores/connections';
import { useHostMetricsStore } from '../../src/stores/hostMetrics';

/**
 * What the two new surfaces draw.
 *
 * The parser's suite covers the arithmetic and the store's covers who owns a
 * reading and when it is dropped. What is only provable here is what the user
 * actually sees: that an unread host is a dash rather than a zero, that a
 * failed refresh keeps the old numbers on screen and labels them as old, that a
 * machine with no card says so instead of drawing an empty bar, and that the
 * badge is its own tap target rather than part of the row that connects.
 */

function snapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    capturedAt: 1_700_000_000_000,
    uptimeSeconds: 152_345,
    cpu: { usedPercent: 42.4, coreCount: 8, load1: 0.52, load5: 0.38, load15: 0.21 },
    memory: {
      totalKb: 32_078_956,
      availableKb: 18_500_000,
      usedKb: 13_578_956,
      usedPercent: 42.3,
      swapTotalKb: 4_095_996,
      swapUsedKb: 95_996,
    },
    gpus: [],
    processes: [],
    procReadable: true,
    ...overrides,
  };
}

let live: App[] = [];

function mount(render: () => ReturnType<typeof h>): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp(defineComponent({ setup: () => render }));
  app.mount(root);
  live.push(app);
  return root;
}

function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function q(root: HTMLElement, testId: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${testId}"]`);
}

async function click(element: HTMLElement | null): Promise<void> {
  element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await nextTick();
}

afterEach(() => {
  for (const app of live) app.unmount();
  live = [];
  installPiLive(null);
  vi.restoreAllMocks();
});

describe('The 连接 row host-load badge', () => {
  it('draws an unread host as a dash, never as a zero', () => {
    const root = mount(() => h(HostLoadBadge, { cpuPercent: null, load1: null }));
    const badge = q(root, 'host-load-badge');
    expect(textOf(badge?.querySelector('.host-badge__cpu'))).toBe('—');
    expect(textOf(badge)).not.toContain('0%');
    expect(badge?.getAttribute('aria-label')).toBe(t('host.badgeUnknown'));
    // A sample in flight says so beside the dash it explains.
    const pending = mount(() => h(HostLoadBadge, { cpuPercent: null, load1: null, pending: true }));
    expect(textOf(q(pending, 'host-load-badge'))).toContain('…');
  });

  it('shows the busy percent beside the one-minute load once there is a reading', () => {
    const root = mount(() => h(HostLoadBadge, { cpuPercent: 42.4, load1: 0.52 }));
    const badge = q(root, 'host-load-badge');
    expect(textOf(badge?.querySelector('.host-badge__cpu'))).toBe('42%');
    expect(textOf(badge?.querySelector('.host-badge__load'))).toBe('0.52');
    expect(badge?.getAttribute('aria-label')).toBe(t('host.badgeAria', { cpu: '42%', load: '0.52' }));
  });

  it('opens the host screen on tap, and does not toggle the connection', async () => {
    let opened = 0;
    const root = mount(() => h(HostLoadBadge, {
      cpuPercent: 1,
      load1: 0,
      onOpen: () => { opened += 1; },
    }));
    await click(q(root, 'host-load-badge'));
    expect(opened).toBe(1);
  });
});

interface ScreenHarness {
  root: HTMLElement;
  connections: ReturnType<typeof useConnectionsStore>;
  metrics: ReturnType<typeof useHostMetricsStore>;
}

/** The screen with its own fresh Pinia, on a host that is already live. */
async function mountScreen(): Promise<ScreenHarness> {
  const pinia = createPinia();
  const connections = useConnectionsStore(pinia);
  // The host is live BEFORE the screen exists: the store watches the live host
  // and drops a reading whose owner changed, so a late `connected` would clear
  // the very snapshot the test is about to put on screen.
  connections.activeName = 'hetzner';
  connections.status = 'connected';
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp(defineComponent({
    setup: () => () => h(HostStatusScreen, { onClose: () => undefined }),
  }));
  app.use(pinia);
  app.mount(root);
  live.push(app);
  const metrics = useHostMetricsStore(pinia);
  metrics.reset();
  await nextTick();
  return { root, connections, metrics };
}

/** A Pi seam whose exec is the test's, so the screen reads a host it chooses. */
function installExec(exec: (command: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>): void {
  installPiLive({
    transport: () => ({ exec, sftpRead: async () => '' }),
    remoteContext: async () => ({ home: '/home/alexey', env: {} }),
    listDirectories: async () => [],
  });
}

describe('The 主机状态 screen', () => {
  it('names the failure instead of painting a panel of dashes when nothing was read', async () => {
    const { root, metrics } = await mountScreen();
    installExec(async () => { throw new Error('SSH exec failed'); });
    await metrics.refresh();
    await nextTick();
    expect(textOf(q(root, 'host-status-error'))).toBe(t('host.failedTransport'));
    expect(root.querySelector('.host-card')).toBeNull();
  });

  it('says there is nothing to read when no connection is live', async () => {
    const { root, connections, metrics } = await mountScreen();
    connections.status = 'idle';
    await metrics.refresh();
    await nextTick();
    expect(textOf(q(root, 'host-status-error'))).toBe(t('host.noConnection'));
  });

  it('keeps the old numbers and says when they were taken when a refresh fails', async () => {
    const { root, metrics } = await mountScreen();
    metrics.snapshot = snapshot();
    metrics.error = 'transport';
    await nextTick();
    const stale = textOf(q(root, 'host-status-stale'));
    expect(stale).toContain(t('host.failedTransport'));
    expect(stale).toContain(t('host.updatedAt', { time: new Date(1_700_000_000_000).toLocaleTimeString() }));
    expect(textOf(root.querySelector('.host-card__percent'))).toBe('42%');
  });

  it('marks a host that gave no /proc data as partial rather than idle', async () => {
    const { root, metrics } = await mountScreen();
    metrics.snapshot = snapshot({
      procReadable: false,
      cpu: { usedPercent: null, coreCount: null, load1: null, load5: null, load15: null },
      memory: { totalKb: null, availableKb: null, usedKb: null, usedPercent: null, swapTotalKb: 0, swapUsedKb: null },
    });
    await nextTick();
    const text = textOf(root);
    expect(text).toContain(t('host.partial'));
    expect(text).toContain('—');
    expect(text).not.toContain('0%');
  });

  it('says no GPU was detected instead of drawing an empty card', async () => {
    const { root, metrics } = await mountScreen();
    metrics.snapshot = snapshot();
    await nextTick();
    expect(textOf(q(root, 'host-gpu-section'))).toContain(t('host.noGpu'));
    expect(root.querySelectorAll('.host-gpu')).toHaveLength(0);
  });

  it('draws one card per GPU, with its video memory, temperature and power', async () => {
    const { root, metrics } = await mountScreen();
    metrics.snapshot = snapshot({
      gpus: [
        {
          vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', utilPercent: 87,
          memoryUsedMb: 12_345, memoryTotalMb: 24_576, temperatureC: 71, powerDrawW: 320.55,
        },
        {
          vendor: 'amd', name: 'AMD card1', utilPercent: 12,
          memoryUsedMb: null, memoryTotalMb: null, temperatureC: null, powerDrawW: null,
        },
      ],
    });
    await nextTick();
    const cards = root.querySelectorAll('.host-gpu');
    expect(cards).toHaveLength(2);
    const first = textOf(cards[0]);
    expect(first).toContain('NVIDIA GeForce RTX 4090');
    expect(first).toContain('12.1 GiB / 24 GiB');
    expect(first).toContain('71 °C');
    expect(first).toContain('320.6 W');
    // A sysfs-only card keeps its row, and dashes what its node never had.
    expect(textOf(cards[1])).toContain('— / —');
  });

  it('lists the busiest processes with their pid and owner', async () => {
    const { root, metrics } = await mountScreen();
    metrics.snapshot = snapshot({
      processes: [
        { pid: 4521, user: 'alexey', cpuPercent: 99.0, memPercent: 5.2, command: 'node' },
        { pid: 900, user: 'alexey', cpuPercent: 12.5, memPercent: 1.0, command: 'Web Content' },
      ],
    });
    await nextTick();
    const rows = root.querySelectorAll('.host-processes tbody tr');
    expect(rows).toHaveLength(2);
    // Each row's own cells, not one joined string: the spans sit side by side
    // in the markup, so `textContent` would glue them together.
    expect(textOf(rows[0]?.querySelector('.host-processes__command'))).toBe('node');
    expect(textOf(rows[0]?.querySelector('.host-processes__meta'))).toBe('4521 · alexey');
    expect(Array.from(rows[0]?.querySelectorAll('.host-processes__num') ?? []).map(textOf)).toEqual(['99.0', '5.2']);
    expect(textOf(rows[1]?.querySelector('.host-processes__command'))).toBe('Web Content');
  });

  it('says when a host returned no process list at all', async () => {
    const { root, metrics } = await mountScreen();
    metrics.snapshot = snapshot({ processes: [] });
    await nextTick();
    expect(textOf(q(root, 'host-status-screen'))).toContain(t('host.noProcesses'));
  });

  it('samples the host again from the refresh button', async () => {
    const { root } = await mountScreen();
    const exec = vi.fn(async () => ({ stdout: 'LOAD 0.10 0.20 0.30 1/1 1\n', stderr: '', exitCode: 0 }));
    installExec(exec);
    await click(q(root, 'host-status-refresh'));
    expect(exec).toHaveBeenCalledWith(hostMetricsCommand(), 15_000);
  });
});
