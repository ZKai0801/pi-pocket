import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import {
  HOST_METRICS_TIMEOUT_MS,
  hostMetricsCommand,
  parseHostMetrics,
  type HostSnapshot,
} from '../host/hostMetrics';
import { piLive } from '../session/piLive';
import { useConnectionsStore } from './connections';

/**
 * The host-load store: one snapshot of whatever host is live, plus the low-rate
 * poll that keeps the 连接 tab's badge honest.
 *
 * It reads the host through the shell's existing Pi seam (`piLive().transport()`,
 * the same bounded exec the projects tab and the Pi repository already use)
 * rather than opening a second road to the connection. That matters on Android
 * specifically: the SSH plugin caps a connection at eight channels shared
 * between PTYs, execs and forwards, so an owner that wanted its own transport
 * would be spending that budget on a status read.
 *
 * The two state rules are the ones the shared usage store already teaches: a
 * failed refresh keeps the previous snapshot and only sets an error, because a
 * stale number is still information and a blank screen is not; and a response is
 * dropped when a newer one has been asked for, or when the host underneath it
 * changed, because the answer describes a machine the user no longer looks at.
 */

/** How often the badge re-samples while the 连接 tab is on screen. */
export const HOST_BADGE_POLL_MS = 45_000;

/** Why the last read failed, as a code the screen puts into words. */
export type HostMetricsError = 'no-connection' | 'transport' | 'unreadable';

export const useHostMetricsStore = defineStore('hostMetrics', () => {
  const connections = useConnectionsStore();

  const snapshot = ref<HostSnapshot | null>(null);
  const loading = ref(false);
  const error = ref<HostMetricsError | null>(null);
  /** The saved-host name the snapshot belongs to, or null when nothing does. */
  const owner = ref<string | null>(null);

  /** Guards against a slow sample landing after a newer one, or after a host switch. */
  let requestSequence = 0;
  const badgeTimer = ref<ReturnType<typeof setInterval> | null>(null);

  /** Whether the badge poll is running — asserted by the tests that arm it. */
  const watched = computed(() => badgeTimer.value !== null);

  /** The host a sample would describe right now, or null when none is live. */
  function liveHost(): string | null {
    if (connections.status !== 'connected') return null;
    return connections.activeName;
  }

  function dropOwner(name: string | null): void {
    owner.value = name;
    snapshot.value = null;
    error.value = null;
  }

  // A host switch, a disconnect, or a redial that has not landed yet all make
  // the current numbers somebody else's, so they go rather than turning grey.
  watch(liveHost, (next) => {
    if (next !== owner.value) dropOwner(next);
  });

  /**
   * One sample. Resolves with whether the snapshot was replaced, and never
   * throws: every failure lands in `error` so the badge can keep showing the
   * last number it did get.
   */
  async function refresh(): Promise<boolean> {
    const host = liveHost();
    if (host === null) {
      dropOwner(null);
      error.value = 'no-connection';
      return false;
    }
    if (host !== owner.value) dropOwner(host);

    const request = requestSequence + 1;
    requestSequence = request;
    loading.value = true;
    error.value = null;

    let stdout: string;
    try {
      const exec = await piLive().transport().exec(hostMetricsCommand(), HOST_METRICS_TIMEOUT_MS);
      stdout = exec.stdout;
    } catch {
      // The seam throws for both "no shell owns a connection yet" and "the read
      // failed". A reconnect that started in the meantime already cleared the
      // owner, so the only case left is the transport itself.
      if (requestSequence !== request) return false;
      loading.value = false;
      error.value = liveHost() === null ? 'no-connection' : 'transport';
      return false;
    }

    if (requestSequence !== request) return false;
    loading.value = false;

    const parsed = parseHostMetrics(stdout, Date.now());
    if (!parsed.procReadable && parsed.processes.length === 0 && parsed.gpus.length === 0) {
      // An empty or wholly unrecognised answer is not "an idle host" — it is a
      // host that did not answer, and showing 0% would be a claim about a
      // machine that never made one.
      error.value = 'unreadable';
      return false;
    }
    snapshot.value = parsed;
    return true;
  }

  function stopBadgePoll(): void {
    if (badgeTimer.value === null) return;
    clearInterval(badgeTimer.value);
    badgeTimer.value = null;
  }

  /**
   * Arm or disarm the badge poll.
   *
   * The 连接 tab is mounted with `v-show`, so "this component is alive" is not
   * "the user can see it" — the shell calls this with the tab and the
   * connection, and an unwatched store never spends a channel on a screen that
   * is hidden. `pollMs` is a parameter rather than a constant for the same
   * reason every other timing knob here is: a test has to be able to cross the
   * interval without waiting out 45 seconds of wall clock.
   */
  function setWatched(next: boolean, pollMs: number = HOST_BADGE_POLL_MS): void {
    if (!next) {
      stopBadgePoll();
      return;
    }
    if (badgeTimer.value !== null) return;
    if (snapshot.value === null || Date.now() - snapshot.value.capturedAt >= pollMs) {
      void refresh();
    }
    badgeTimer.value = setInterval(() => {
      void refresh();
    }, pollMs);
  }

  /** The shell's teardown path: no timer, no numbers, no error left on screen. */
  function reset(): void {
    stopBadgePoll();
    // Supersede whatever is in flight, so its answer cannot land after the
    // teardown and repopulate the screen it no longer belongs to.
    requestSequence += 1;
    dropOwner(null);
    loading.value = false;
  }

  return { snapshot, loading, error, owner, watched, refresh, setWatched, reset };
});
