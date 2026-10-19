import { describe, expect, it } from 'vitest';
import phoneAppSource from '../../src/phone/PhoneApp.vue?raw';
import connectionsListSource from '../../src/components/connections/ConnectionsList.vue?raw';
import projectsListSource from '../../src/components/projects/ProjectsList.vue?raw';
import connectionEditorSource from '../../src/components/connections/ConnectionEditor.vue?raw';
import projectsStoreSource from '../../src/stores/projects.ts?raw';
import sessionsStoreSource from '../../src/stores/sessions.ts?raw';

describe('phone shell wiring', () => {
  it('installs the Back listener, snapshot sync, and app-state lifecycle in the shell', () => {
    expect(phoneAppSource).toContain('installBackButton(');
    expect(phoneAppSource).toContain('runHomeBack(');
    expect(phoneAppSource).toContain('installAppStateLifecycle(');
    expect(phoneAppSource).toContain('createConnectionSnapshotSync<');
    expect(phoneAppSource).toContain('next.subscribe(forwardSnapshot)');
    expect(phoneAppSource).toContain('applyConnectionSnapshot(');
    expect(phoneAppSource).toContain('createShellBackNavigation(');
    expect(phoneAppSource).toContain('closeOverlay: closeTopmostOverlay');
    expect(phoneAppSource).toContain('closeTopmostOverlay');
    expect(phoneAppSource).toContain('terminalTarget.value = null');
    expect(phoneAppSource).toContain('projects.closeBrowse()');
    expect(phoneAppSource).toContain("hasLiveConnection: () => connections.status === 'connected'");
  });

  it('routes host actions through the store seams', () => {
    expect(connectionsListSource).toContain('store.requestConnect(');
    expect(connectionsListSource).toContain('editing.value?.name');
    expect(connectionsListSource).toContain('store.statusFor(');
    expect(projectsListSource).toContain('savePiSessionsDir(');
    expect(projectsListSource).toContain("connections.status === 'connected'");
  });

  it('remembers the probed root and preloads the editor from it', () => {
    expect(projectsStoreSource).toContain('resolveAndRememberRoot(');
    expect(sessionsStoreSource).toContain('resolveAndRememberRoot(');
    expect(connectionEditorSource).toContain('piSessionsDirFor(');
  });
});
