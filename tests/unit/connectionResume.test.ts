import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import phoneAppSource from '../../src/phone/PhoneApp.vue?raw';
import settingsTabSource from '../../src/components/settings/SettingsTab.vue?raw';
import { MOBILE_RETRY_DELAYS_MS } from '../../src/session/connectionController';

function tsSource(relative: string): string {
  return readFileSync(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
}

/**
 * Losing a session to a screen that was off for a few seconds has two causes,
 * and this file pins both: the reconnect ladder that gives up before the
 * radio is back, and the cold start that never dials at all.
 */
describe('resuming the last SSH connection', () => {
  it('gives the phone a reconnect ladder that outlasts the network ramp', () => {
    // Core's shared ladder spends five dials inside 3.75 s, which is right
    // for a machine whose network is already there. A phone lighting its
    // screen up spends those seconds re-attaching Wi-Fi or mobile data, so a
    // ladder that short ends in `lost` before the first dial could succeed.
    const total = MOBILE_RETRY_DELAYS_MS.reduce<number>((sum, delay) => sum + delay, 0);
    expect(total).toBeGreaterThan(20_000);
    expect(total).toBeLessThan(60_000);
    expect(MOBILE_RETRY_DELAYS_MS[0]).toBe(0);
    expect(MOBILE_RETRY_DELAYS_MS.length).toBeGreaterThan(4);
    // It backs off; it does not hammer a host that is not answering yet.
    for (let index = 1; index < MOBILE_RETRY_DELAYS_MS.length; index += 1) {
      expect(MOBILE_RETRY_DELAYS_MS[index]).toBeGreaterThanOrEqual(MOBILE_RETRY_DELAYS_MS[index - 1]);
    }
  });

  it('passes that ladder to the shared controller instead of the shared default', () => {
    const controller = tsSource('session/connectionController.ts');
    expect(controller).toContain('retryDelaysMs: options.retryDelaysMs ?? MOBILE_RETRY_DELAYS_MS');
    expect(controller).toContain('capability: sshCapability');
  });

  it('remembers the dialled host and dials it again on the next cold start', () => {
    // The alias, not the endpoint: a target names `user@host:port` while the
    // saved list is keyed by name, so remembering `target.hostId` made every
    // cold start look like a deleted host and skipped the dial.
    expect(phoneAppSource).toContain('rememberLaunchHost(target)');
    expect(phoneAppSource).not.toContain('rememberLaunchHost(target.hostId)');
    expect(phoneAppSource).toContain('sharedSettings.defaultHost = name');
    expect(phoneAppSource).toContain('decideLaunchReconnect(');
    // The latch comes BEFORE the dial: a host that cannot be reached must not
    // become a loop on the next mount.
    expect(phoneAppSource.indexOf('markLaunchReconnectAttempted()'))
      .toBeLessThan(phoneAppSource.indexOf('await connections.connect(decision.name)'));
  });

  it('waits for the saved hosts before deciding, and stops watching after', () => {
    // The host list arrives from a dynamic import, so a mount that beats it
    // must decide again when the list lands.
    expect(phoneAppSource).toContain("watchLaunchReconnect()");
    expect(phoneAppSource).toContain('() => connections.hosts.length');
    expect(phoneAppSource).toContain('stopLaunchReconnectWatch?.()');
  });

  it('holds the grace window and return-reconnect as phone constants, not stored settings', () => {
    // No background keep-alive here, so a longer window mostly buys time Doze
    // takes back anyway. Constants also retire a stored `false` — 0.5.x carried
    // `reconnect_when_return` over — which would park the phone on `lost` with
    // no control left to change it.
    const controller = tsSource('session/connectionController.ts');
    expect(controller).toContain('MOBILE_BACKGROUND_GRACE_MS = 90_000');
    expect(controller).toContain('MOBILE_RECONNECT_ON_RETURN = true');
    expect(phoneAppSource).toContain('getBackgroundGraceMs: () => MOBILE_BACKGROUND_GRACE_MS');
    expect(phoneAppSource).toContain('getReconnectOnReturn: () => MOBILE_RECONNECT_ON_RETURN');
    expect(phoneAppSource).not.toContain('sharedSettings.backgroundGraceMs');
    expect(phoneAppSource).not.toContain('sharedSettings.reconnectOnReturn');
  });

  it('explains the phone behaviour on the settings screen instead of offering the two controls', () => {
    // The desktop shell still edits both through core's group; the phone only
    // says what it does, so there is no second copy of the control to drift.
    expect(settingsTabSource).not.toContain('setting-background-grace');
    expect(settingsTabSource).not.toContain('setting-reconnect-on-return');
    expect(settingsTabSource).not.toContain('shared.set(');
    expect(settingsTabSource).toContain("t('settings.autoReconnectNote')");
    expect(settingsTabSource).toContain("t('settings.launchReconnectNote')");
    const lifecycle = tsSource('phone/appStateLifecycle.ts');
    expect(lifecycle).toContain('appStateChange');
  });
});
