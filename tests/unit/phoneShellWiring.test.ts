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

  it('lands on the 会话 tab when a project is tapped', () => {
    // The list owns no tab state: it selects the project and asks the shell
    // to move, and the shell is the one holding `activeTab` (spec §8.5).
    expect(projectsListSource).toContain("defineEmits<{ open: [path: string] }>()");
    expect(projectsListSource).toContain('store.select(path);');
    expect(projectsListSource).toContain("emit('open', path);");
    expect(phoneAppSource).toContain('@open="openProjectSessions"');
    expect(phoneAppSource).toContain("activeTab.value = 'sessions'");
  });

  it('remembers the probed root and preloads the editor from it', () => {
    expect(projectsStoreSource).toContain('resolveAndRememberRoot(');
    expect(sessionsStoreSource).toContain('resolveAndRememberRoot(');
    expect(connectionEditorSource).toContain('piSessionsDirFor(');
  });

  it('stacks the key vault sheet on the 连接 tab instead of adding a fourth tab (R31/R34)', () => {
    // The sheet is a pushed view of the 连接 tab, so Back pops it before the editor.
    expect(phoneAppSource).toContain("backStack.push('connections', 'keys')");
    expect(phoneAppSource).toContain('@update:keys-open="setKeysOpen"');
    // A sheet above the editor must not unmount the form that owns the handle.
    expect(phoneAppSource).toContain(':editor-open="connectionView !== null"');
    expect(phoneAppSource).toContain(":keys-open=\"connectionView === 'keys'\"");
    expect(connectionsListSource).toContain('@update:keys-open=');
    expect(connectionsListSource).toContain(':keys-open="keysOpen === true"');
    // Closing the editor clears the whole tab stack, not one entry (see
    // `clearViews` in backNavigation.ts and its own unit tests).
    expect(phoneAppSource).toContain("clearViews(backStack, 'connections')");
  });

  it('reuses the one key manager and the one vault screen (R32)', () => {
    expect(connectionEditorSource).toContain("import SshKeysScreen from '../SshKeysScreen.vue'");
    expect(connectionEditorSource).toContain("from '../../platform/android/hosts'");
    expect(connectionEditorSource).toContain(':manager="androidKeyManager"');
    // No second manager on this path; the singleton comes from hosts.ts.
    expect(connectionEditorSource).not.toContain('new CredentialKeyManager');
  });
});
