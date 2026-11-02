import { describe, expect, it } from 'vitest';
import {
  HOST_METRICS_PROCESS_LIMIT,
  HOST_METRICS_TAG,
  HOST_METRICS_TIMEOUT_MS,
  hostMetricsCommand,
} from '../../src/host/hostMetrics';

/**
 * The shape of the one command that samples a host.
 *
 * These are the properties the rest of the feature is built on and cannot
 * re-derive at runtime: that every section announces itself, that nothing is
 * installed or written on the host (D45), that the read is bounded in both rows
 * and time, and that a non-POSIX login shell still runs it.
 */
describe('The host metrics sample command', () => {
  it('tags every section the parser reads, so a stray line cannot masquerade as one', () => {
    const command = hostMetricsCommand();
    for (const tag of Object.values(HOST_METRICS_TAG)) {
      expect(command).toContain(tag);
    }
    // Two tags are stamped onto output this app does not control, so they have
    // to be there literally — a renamed constant would silently un-tag a
    // section. The `sed` argument is inside the single-quoted script, so
    // quoteShell has already escaped its own quotes: match the substitution's
    // body, which is the part that reaches the host's stdout.
    expect(command).toContain(`s/^/${HOST_METRICS_TAG.nvidia} `);
    expect(command).toContain(`s/^/${HOST_METRICS_TAG.process} `);
  });

  it('installs nothing, writes nothing, and redirects nothing to a file (D45)', () => {
    const command = hostMetricsCommand();
    // Whole words only: `SwapTotal` contains "apt", and a substring check would
    // make this assertion fail on the `/proc` field it exists to read.
    for (const forbidden of ['apt', 'yum', 'dnf', 'pip', 'curl', 'wget', 'nvtop', 'htop', 'mkdir']) {
      expect(command.toLowerCase()).not.toMatch(new RegExp(`(^|[^a-z])${forbidden}([^a-z]|$)`));
    }
    // Every `>` in the script aims at /dev/null. `>&1` is excluded by the
    // capture class because it duplicates a descriptor rather than naming a file.
    const targets = Array.from(command.matchAll(/>+\s*([^ \t|;&)]+)/g), (match) => match[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target).toBe('/dev/null');
  });

  it('probes for the GPU tool instead of assuming it, and keeps a no-tool AMD path', () => {
    const command = hostMetricsCommand();
    expect(command).toContain('command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi');
    // The `&&` IS the detection: no binary, no line, no error.
    expect(command).toContain('/sys/class/drm/card*/device/gpu_busy_percent');
    expect(command).toContain('[ -e "$f" ]');
  });

  it('runs under sh whatever the login shell is, with its quoting intact', () => {
    const command = hostMetricsCommand();
    expect(command.startsWith('sh -c \'')).toBe(true);
    expect(command.endsWith("'")).toBe(true);
    // quoteShell escapes an embedded single quote by ending the literal, adding
    // an escaped one, and reopening — never by leaving a bare `\'` behind.
    expect(command).toContain(`'\\''`);
    expect(command).not.toContain('`');
  });

  it('bounds the payload by rows and by time', () => {
    const command = hostMetricsCommand();
    expect(command).toContain(`head -n ${HOST_METRICS_PROCESS_LIMIT}`);
    expect(command).toContain('sleep 1');
    // BusyBox `sort` has `-n` and not `-g`; asking for the GNU-only flag would
    // silently drop the whole process section on a router-ish host.
    expect(command).toContain('sort -k 2,2 -n -r');
    expect(command).not.toMatch(/sort[^|]*-g/);
    // The exec timeout has to outlast the script's own one-second window.
    expect(HOST_METRICS_TIMEOUT_MS).toBeGreaterThan(1_000);
  });

  it('never asks for zero or a fractional number of processes', () => {
    expect(hostMetricsCommand(0)).toContain('head -n 1');
    expect(hostMetricsCommand(-5)).toContain('head -n 1');
    expect(hostMetricsCommand(3.7)).toContain('head -n 3');
    expect(hostMetricsCommand(50)).toContain('head -n 50');
  });

  it('keeps one POSIX script on one line, so no multi-line exec ever reaches sshd', () => {
    const command = hostMetricsCommand();
    expect(command.includes('\n')).toBe(false);
    expect(command.split('; ').length).toBeGreaterThan(8);
  });
});
