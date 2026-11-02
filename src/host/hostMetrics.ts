import { quoteShell } from '../pi/piCommands';

/**
 * Reading the host's own load — the CPU, memory, GPU and process figures behind
 * the 连接 tab's badge and the 主机状态 page.
 *
 * Two rules shape this module, and both come from decisions already locked:
 *
 * D45 says the phone rides SSH, `pi` and plain POSIX commands with nothing
 * installed on the host. So there is no helper here, no `apt install` step, no
 * "if the PocketShell CLI is present" branch: one `sh -c` script reads
 * `/proc`, asks `ps` for its top rows, and calls `nvidia-smi` only to find out
 * whether that binary happens to exist. A host with nothing to answer prints
 * nothing for that section, and the parser turns a missing section into a null
 * rather than an error.
 *
 * D45 also removed the phone's terminal screen, which is why this sampling
 * exists at all. The shared desktop/web shell answers "what is this host doing"
 * by typing `htop` into a bare login shell (core's `app/maintenance.ts`), an
 * approach deliberately chosen over a panel that samples the host itself. The
 * phone has no terminal to hand that question to, so it asks the host directly
 * and draws the numbers itself — the narrowest thing that answers the question,
 * not a re-implementation of htop's UI.
 *
 * Everything here is pure: the command is a string, the parse is a function of
 * that string, and the clock arrives as an argument. The store that polls it and
 * the components that draw it are elsewhere, so the whole awkward surface —
 * foreign shells, absent GPUs, half-written `/proc` lines — is testable without
 * an SSH connection.
 */

/** One line of the sample, tagged so the parse never has to guess a section. */
export const HOST_METRICS_TAG = {
  load: 'LOAD',
  cores: 'CORES',
  cpuBefore: 'CPU1',
  cpuAfter: 'CPU2',
  memory: 'MEM',
  uptime: 'UP',
  nvidia: 'GPU',
  amd: 'AGPU',
  process: 'PROC',
} as const;

/**
 * How long the CPU window is. `/proc/stat` counts jiffies since boot, so a
 * usage percentage needs two reads and only the difference between them means
 * anything; one second is long enough that the delta is not swamped by the
 * rounding of a busy HZ=100 kernel.
 */
export const HOST_METRICS_CPU_WINDOW_SECONDS = 1;

/** Rows the remote `head` keeps, and the ceiling the parse will accept. */
export const HOST_METRICS_PROCESS_LIMIT = 15;

/**
 * The exec timeout for one sample. It has to outlast the script's own `sleep 1`
 * plus a full round trip; the phone's shell already uses 15s for its one-shot
 * probes, and a sample that takes longer than that is a host in trouble.
 */
export const HOST_METRICS_TIMEOUT_MS = 15_000;

/**
 * The sample script, as one line.
 *
 * It runs under `sh -c` rather than straight on the login shell because the
 * user's login shell is not necessarily POSIX at all — `$SHELL` can be csh or
 * fish, where `$(...)`, `command -v` and `&&` in this shape do not exist. One
 * `quoteShell` around the script makes the POSIX promise local instead of
 * global, and every host gets the same interpreter.
 *
 * Each section is prefixed with its tag and sent through the same one exec
 * channel: `head`/`cat` on `/proc` cost nothing, and `2>/dev/null` everywhere
 * keeps a host that has no `/proc` (the BSDs, a weird container) from mixing
 * `sh: /proc/stat: No such file` into the output the parser reads.
 */
export function hostMetricsCommand(processLimit: number = HOST_METRICS_PROCESS_LIMIT): string {
  const limit = Math.max(1, Math.floor(processLimit));
  const script = [
    `echo "LOAD $(cat /proc/loadavg 2>/dev/null)"`,
    `echo "CORES $(grep -c '^cpu[0-9]' /proc/stat 2>/dev/null)"`,
    `echo "CPU1 $(head -n 1 /proc/stat 2>/dev/null)"`,
    `sleep ${HOST_METRICS_CPU_WINDOW_SECONDS}`,
    `echo "CPU2 $(head -n 1 /proc/stat 2>/dev/null)"`,
    // The `tr` is what keeps this one line: command substitution preserves the
    // newlines grep printed, and an un-tagged continuation line would read as
    // an unknown row instead of part of MEM.
    `echo "MEM $(grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null | tr '\\n' ' ')"`,
    `echo "UP $(cut -d ' ' -f 1 /proc/uptime 2>/dev/null)"`,
    // NVIDIA ships `nvidia-smi` with the proprietary driver, so its presence IS
    // the GPU probe — no installation to assume. `nounits` keeps the numbers
    // bare, and the `sed` tags every card so a multi-GPU host stays parseable.
    `command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null | sed 's/^/${HOST_METRICS_TAG.nvidia} /'`,
    // AMD needs no tool at all: the kernel driver exposes utilisation as a
    // readable file. Memory and temperature are not uniformly there, so this
    // reports what the sysfs node actually answers and nothing more.
    `for f in /sys/class/drm/card*/device/gpu_busy_percent; do [ -e "$f" ] && echo "${HOST_METRICS_TAG.amd} $(cat "$f" 2>/dev/null) $f"; done`,
    // `sort -k 2,2 -n -r` is best-effort ordering: `-n` (not `-g`) is the flag
    // BusyBox `sort` also has, so a router-ish host still yields sorted rows,
    // and the parse re-sorts whatever arrives. `head -n` bounds the payload
    // before it ever crosses the wire.
    `ps -eo pid=,pcpu=,pmem=,user=,comm= 2>/dev/null | sort -k 2,2 -n -r 2>/dev/null | head -n ${limit} | sed 's/^/${HOST_METRICS_TAG.process} /'`,
  ].join('; ');
  return `sh -c ${quoteShell(script)}`;
}

export interface HostCpuSample {
  /** Percent of ALL cores busy over the sample window, or null when unreadable. */
  usedPercent: number | null;
  coreCount: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
}

export interface HostMemorySample {
  totalKb: number | null;
  availableKb: number | null;
  /** Linux counts kernel buffers/cache in "free", so "used" means total − available. */
  usedPercent: number | null;
  usedKb: number | null;
  swapTotalKb: number;
  swapUsedKb: number | null;
}

export type HostGpuVendor = 'nvidia' | 'amd';

export interface HostGpuSample {
  vendor: HostGpuVendor;
  name: string;
  utilPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  temperatureC: number | null;
  powerDrawW: number | null;
}

export interface HostProcessRow {
  pid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  command: string;
}

export interface HostSnapshot {
  /** When the sample was taken, from the caller's clock — never the host's. */
  capturedAt: number;
  uptimeSeconds: number | null;
  cpu: HostCpuSample;
  memory: HostMemorySample;
  gpus: HostGpuSample[];
  processes: HostProcessRow[];
  /**
   * False when no `/proc` section answered at all: a non-Linux host, or a read
   * that came back empty. The page says so instead of painting a screen of
   * dashes, which would read as "idle" rather than as "unreadable".
   */
  procReadable: boolean;
}

const EMPTY_CPU: HostCpuSample = { usedPercent: null, coreCount: null, load1: null, load5: null, load15: null };
const EMPTY_MEMORY: HostMemorySample = {
  totalKb: null,
  availableKb: null,
  usedPercent: null,
  usedKb: null,
  swapTotalKb: 0,
  swapUsedKb: null,
};

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  // `nvidia-smi` writes `[Not Supported]` and `[N/A]` into numeric columns on
  // some driver builds, and a locale can use a comma.
  const parsed = Number.parseFloat(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Busy percent from two `/proc/stat` aggregate lines.
 *
 * The fields are `user nice system idle iowait irq softirq steal …`; idle plus
 * `iowait` is the idle the kernel itself counts, and everything else is work.
 * A guest kernel that has been up through a counter reset, or a window where
 * nothing advanced, yields a non-positive total delta — reported as no reading
 * rather than as 0%, because "0%" is a claim about the machine.
 */
export function cpuPercentFromStatLines(before: string | undefined, after: string | undefined): number | null {
  const fields = (line: string | undefined): number[] | null => {
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== 'cpu') return null;
    const values = parts.slice(1).map((part) => Number.parseInt(part, 10));
    return values.every((value) => Number.isFinite(value)) ? values : null;
  };
  const first = fields(before);
  const second = fields(after);
  if (!first || !second || first.length !== second.length) return null;
  let totalDelta = 0;
  let idleDelta = 0;
  for (let index = 0; index < first.length; index += 1) {
    const delta = second[index] - first[index];
    if (delta < 0) return null;
    totalDelta += delta;
    // 3 = idle, 4 = iowait in every kernel since 2.5.
    if (index === 3 || index === 4) idleDelta += delta;
  }
  if (totalDelta <= 0) return null;
  return roundTenth(clampPercent(((totalDelta - idleDelta) / totalDelta) * 100));
}

/** `0.52 0.38 0.21 2/345 6789` → the three load averages. */
export function parseLoadAvg(line: string | undefined): { load1: number | null; load5: number | null; load15: number | null } {
  const parts = (line ?? '').trim().split(/\s+/);
  return { load1: numberOrNull(parts[0]), load5: numberOrNull(parts[1]), load15: numberOrNull(parts[2]) };
}

/** `MemTotal: 32078956 kB MemAvailable: 21000000 kB …` → the four counters read. */
export function parseMemInfo(line: string | undefined): HostMemorySample {
  const read = (name: string): number | null => {
    const match = new RegExp(`${name}:\\s*(\\d+)`).exec(line ?? '');
    return match ? Number.parseInt(match[1], 10) : null;
  };
  const total = read('MemTotal');
  const available = read('MemAvailable');
  const swapTotal = read('SwapTotal') ?? 0;
  const swapFree = read('SwapFree');
  const used = total !== null && available !== null ? Math.max(0, total - available) : null;
  return {
    totalKb: total,
    availableKb: available,
    usedKb: used,
    usedPercent: total !== null && total > 0 && used !== null ? roundTenth(clampPercent((used / total) * 100)) : null,
    swapTotalKb: swapTotal,
    swapUsedKb: swapTotal !== null && swapFree !== null ? Math.max(0, swapTotal - swapFree) : null,
  };
}

/**
 * One `nvidia-smi --format=csv,noheader,nounits` row.
 *
 * The GPU name is the only field that can contain `", "`, so the numbers are
 * counted from the END of the row and whatever is left over is the name. Taking
 * them by fixed index would shift every figure sideways on a card whose model
 * name carries a comma.
 */
export function parseNvidiaRow(rest: string): HostGpuSample | null {
  const parts = rest.split(',').map((part) => part.trim());
  if (parts.length < 7) return null;
  const tail = parts.slice(parts.length - 5);
  return {
    vendor: 'nvidia',
    // Re-joined with the separator CSV uses, so a model name that carries a
    // comma survives the split that made it parseable.
    name: parts.slice(1, parts.length - 5).join(', ') || `GPU ${parts[0]}`,
    utilPercent: clampNumeric(tail[0]),
    memoryUsedMb: clampNonNegative(tail[1]),
    memoryTotalMb: clampNonNegative(tail[2]),
    temperatureC: clampNonNegative(tail[3]),
    powerDrawW: clampNonNegative(tail[4]),
  };
}

/** A plain non-negative reading — MiB, degrees and watts are not percentages. */
function clampNonNegative(value: string | undefined): number | null {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function clampNumeric(value: string | undefined): number | null {
  const parsed = numberOrNull(value);
  return parsed === null ? null : clampPercent(parsed);
}

/**
 * One `ps -eo pid=,pcpu=,pmem=,user=,comm=` row.
 *
 * The first four fields are single tokens; the command is everything after them
 * because `comm` can and does contain spaces (`Web Content`, `kworker/0:1H`).
 * A header line from a `ps` that ignored the `=` suppression, or a truncated
 * row, simply has a non-numeric pid and is dropped.
 */
export function parseProcessRow(rest: string): HostProcessRow | null {
  const parts = rest.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const pid = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const cpu = numberOrNull(parts[1]);
  const memory = numberOrNull(parts[2]);
  if (cpu === null || memory === null) return null;
  return {
    pid,
    user: parts[3],
    cpuPercent: cpu,
    memPercent: memory,
    command: parts.slice(4).join(' '),
  };
}

/** `/sys/class/drm/cardN/device/gpu_busy_percent` → the name the path gives. */
export function parseAmdRow(rest: string): HostGpuSample | null {
  const parts = rest.trim().split(/\s+/);
  const busy = clampNumeric(parts[0]);
  const path = parts.slice(1).join(' ');
  if (busy === null) return null;
  const card = /\/(card\d+)\//.exec(path)?.[1];
  return {
    vendor: 'amd',
    name: card ? `AMD ${card}` : 'AMD GPU',
    utilPercent: busy,
    memoryUsedMb: null,
    memoryTotalMb: null,
    temperatureC: null,
    powerDrawW: null,
  };
}

/**
 * The sample's stdout, read as one snapshot of the host.
 *
 * Tolerant by construction: an unknown line is skipped, an unparsable section
 * leaves its fields null, and a sample with nothing readable at all still
 * returns the reading with `procReadable: false`, so the page can say the host
 * answered rather than showing zeroes.
 */
export function parseHostMetrics(stdout: string, capturedAt: number): HostSnapshot {
  let loadLine: string | undefined;
  let coresLine: string | undefined;
  let cpuBefore: string | undefined;
  let cpuAfter: string | undefined;
  let memLine: string | undefined;
  let uptimeLine: string | undefined;
  const nvidiaRows: string[] = [];
  const amdRows: string[] = [];
  const processRows: string[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const space = line.indexOf(' ');
    const tag = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? '' : line.slice(space + 1).trim();
    switch (tag) {
      case HOST_METRICS_TAG.load:
        loadLine = rest;
        break;
      case HOST_METRICS_TAG.cores:
        coresLine = rest;
        break;
      case HOST_METRICS_TAG.cpuBefore:
        cpuBefore = rest;
        break;
      case HOST_METRICS_TAG.cpuAfter:
        cpuAfter = rest;
        break;
      case HOST_METRICS_TAG.memory:
        memLine = rest;
        break;
      case HOST_METRICS_TAG.uptime:
        uptimeLine = rest;
        break;
      case HOST_METRICS_TAG.nvidia:
        if (rest) nvidiaRows.push(rest);
        break;
      case HOST_METRICS_TAG.amd:
        if (rest) amdRows.push(rest);
        break;
      case HOST_METRICS_TAG.process:
        if (rest) processRows.push(rest);
        break;
      default:
        break;
    }
  }

  const load = parseLoadAvg(loadLine);
  const cores = numberOrNull(coresLine?.split(/\s+/)[0]);
  const memory = parseMemInfo(memLine);
  const uptime = numberOrNull(uptimeLine?.split(/\s+/)[0]);

  const gpus = [
    ...nvidiaRows.map(parseNvidiaRow),
    ...amdRows.map(parseAmdRow),
  ].filter((gpu): gpu is HostGpuSample => gpu !== null);

  const processes = processRows
    .map(parseProcessRow)
    .filter((row): row is HostProcessRow => row !== null)
    .slice(0, HOST_METRICS_PROCESS_LIMIT)
    .sort((left, right) => right.cpuPercent - left.cpuPercent);

  const usedPercent = cpuPercentFromStatLines(cpuBefore, cpuAfter);

  return {
    capturedAt,
    uptimeSeconds: uptime !== null && uptime >= 0 ? uptime : null,
    cpu: { ...EMPTY_CPU, ...load, usedPercent, coreCount: cores !== null && cores > 0 ? cores : null },
    memory: { ...EMPTY_MEMORY, ...memory },
    gpus,
    processes,
    procReadable: loadLine !== undefined
      || cpuBefore !== undefined
      || memLine !== undefined
      || uptimeLine !== undefined,
  };
}

/* ------------------------------------------------------------ formatting */

/** `42.0` → `42%`, `null` → an em dash; a reading is never shown as zero. */
export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}%`;
}

/**
 * A GiB figure in the words the phone shows.
 *
 * One decimal keeps "30.6 of 31 GiB used" readable, a card that is exactly
 * 24 GiB says "24 GiB" rather than "24.0", and above 100 GiB the decimal is
 * noise the user cannot act on.
 */
function gibLabel(gib: number): string {
  if (gib >= 100 || Number.isInteger(gib)) return `${Math.round(gib)} GiB`;
  return `${gib.toFixed(1)} GiB`;
}

/** Kilobytes from `/proc/meminfo` → the GiB the bar is labelled with. */
export function formatKibibytes(kb: number | null): string {
  if (kb === null || !Number.isFinite(kb) || kb < 0) return '—';
  const gib = kb / 1024 / 1024;
  // Below a GiB the figure is a process's footprint, where MiB is the unit
  // people actually compare in.
  if (gib >= 1) return gibLabel(gib);
  return `${Math.max(1, Math.round(kb / 1024))} MiB`;
}

/**
 * Megabytes from `nvidia-smi`'s `--format=...,nounits` → the GiB a card is
 * usually described in. Same readable range as the RAM figure above it.
 */
export function formatMegabytes(mb: number | null): string {
  if (mb === null || !Number.isFinite(mb) || mb < 0) return '—';
  if (mb < 1024) return `${Math.round(mb)} MiB`;
  return gibLabel(mb / 1024);
}

/** Seconds from `/proc/uptime` → `3d 4h`, `4h 12m`, `7m`. */
export function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** A load average of `null` and a load average of `0` are different claims. */
export function formatLoad(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(2);
}
