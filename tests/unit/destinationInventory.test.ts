import { describe, expect, it } from 'vitest';
import { DESTINATION_INVENTORY, REQUIRED_OLD_DESTINATIONS } from '../../src/destinationInventory';

const PRE_REWRITE_DESTINATIONS = [
  'Hosts', 'Settings', 'TerminalSettings', 'VoiceSettings', 'ConnectionSettings', 'AdvancedSettings',
  'AccountSync', 'Diagnostics', 'DiagnosticReport', 'About', 'Update', 'Usage', 'HostUsage',
  'Workspaces', 'WorkspaceRootAction', 'Workspace', 'WorkspaceStart', 'ReorderWorkspaces', 'Tree',
  'Session', 'Files', 'FileViewer', 'Ports', 'TunnelDetail', 'AddTunnel', 'HostForm', 'SshKeys',
  'WorkspaceRoots', 'AddWorkspaceRoot',
  'CrashReports',
];

describe('pre-rewrite destination inventory', () => {
  it('maps each shipped destination to a replacement route, owning issue, and implementation status', () => {
    const mappings = new Map(DESTINATION_INVENTORY.map((entry) => [entry.oldDestination, entry]));
    for (const destination of PRE_REWRITE_DESTINATIONS) expect(mappings.has(destination), destination).toBe(true);
    expect(mappings.size).toBe(DESTINATION_INVENTORY.length);
    expect(DESTINATION_INVENTORY.map((entry) => entry.oldDestination)).toEqual(expect.arrayContaining(PRE_REWRITE_DESTINATIONS));
    expect(DESTINATION_INVENTORY.every((entry) => entry.newRoute && entry.owner && entry.note)).toBe(true);
  });

  it('states which prior settings/support surfaces have working routes in this slice', () => {
    expect(DESTINATION_INVENTORY.find((entry) => entry.oldDestination === 'Settings')?.status).toBe('available');
    // The legacy shell's usage, port-forward, files, diagnostics, about and
    // terminal/voice/advanced settings surfaces went with the chat-only cut;
    // only the removed status may describe them now.
    for (const destination of ['Usage', 'HostUsage', 'Ports', 'TunnelDetail', 'AddTunnel', 'Diagnostics', 'DiagnosticReport', 'ClearReports', 'About', 'Update', 'Files', 'FileViewer', 'TerminalSettings', 'VoiceSettings', 'ConnectionSettings', 'AdvancedSettings', 'Grace']) {
      expect(DESTINATION_INVENTORY.find((entry) => entry.oldDestination === destination)?.status, destination).toBe('removed');
    }
    expect(REQUIRED_OLD_DESTINATIONS.length).toBe(DESTINATION_INVENTORY.length);
  });

  it('marks the file workspace routes removed with the legacy shell (the chat-only cut keeps no files route)', () => {
    for (const destination of ['Files', 'FileViewer']) {
      const mapping = DESTINATION_INVENTORY.find((entry) => entry.oldDestination === destination);
      expect(mapping?.newRoute).toBe('files');
      expect(mapping?.status).toBe('removed');
      expect(mapping?.note).toContain('Removed with the legacy shell');
    }
  });

  it('hands the workspace, host, and session-verb rows to their open follow-ups, not the closed HostCliCore contract issue', () => {
    expect(DESTINATION_INVENTORY.filter((entry) => entry.owner.includes('#2851'))).toEqual([]);
    for (const destination of ['Workspaces', 'WorkspaceRootAction', 'Workspace', 'ReorderWorkspaces', 'Tree', 'WorkspaceRoots', 'AddWorkspaceRoot']) {
      expect(DESTINATION_INVENTORY.find((entry) => entry.oldDestination === destination)?.owner, destination).toContain('#2925');
    }
    expect(DESTINATION_INVENTORY.find((entry) => entry.oldDestination === 'WorkspaceStart')?.owner).toContain('#2939');
  });
});
