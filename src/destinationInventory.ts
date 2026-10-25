/** Route map from the 0.5.x Destinations graph to the JS-first rewrite. */
export interface DestinationMapping {
  oldDestination: string;
  newRoute: string;
  status: 'partial' | 'available' | 'information-only' | 'planned' | 'removed';
  owner: string;
  note: string;
}

export const DESTINATION_INVENTORY: readonly DestinationMapping[] = [
  { oldDestination: 'Hosts', newRoute: 'home', status: 'partial', owner: '#2924/#2856', note: 'One-off SSH form is available; saved host management is pending.' },
  { oldDestination: 'Settings', newRoute: 'settings', status: 'available', owner: '#2861', note: 'Settings index links to the replacement settings and support routes.' },
  { oldDestination: 'TerminalSettings', newRoute: 'settings-terminal', status: 'removed', owner: '#2861', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'VoiceSettings', newRoute: 'settings-voice', status: 'removed', owner: '#2857', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'ConnectionSettings', newRoute: 'settings-connections', status: 'removed', owner: '#2861', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'AdvancedSettings', newRoute: 'settings-advanced', status: 'removed', owner: '#2861/#2936', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'AccountSync', newRoute: 'settings-account', status: 'available', owner: '#3020/#2852', note: 'Google sign-in (Credential Manager, token kept natively), passphrase-encrypted host sync through core runSyncRound; synced hosts fill the home connection form.' },
  { oldDestination: 'Diagnostics', newRoute: 'diagnostics', status: 'removed', owner: '#2861', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'CrashReports', newRoute: 'diagnostics', status: 'removed', owner: '#2861', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'DiagnosticReport', newRoute: 'diagnostics-report', status: 'removed', owner: '#2861', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'About', newRoute: 'about', status: 'removed', owner: '#2861', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'Update', newRoute: 'about-update', status: 'removed', owner: '#2861/#2936', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'Usage', newRoute: 'usage', status: 'removed', owner: '#2859', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'HostUsage', newRoute: 'usage', status: 'removed', owner: '#2859', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'Workspaces', newRoute: 'home', status: 'partial', owner: '#2925/#2856', note: 'The current home screen lists sessions after connection; workspace roots remain pending.' },
  { oldDestination: 'WorkspaceRootAction', newRoute: 'pending-workspaces', status: 'removed', owner: '#2925/#2856', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'Workspace', newRoute: 'home', status: 'removed', owner: '#2925/#2856', note: 'Removed with the terminal surface (chat-only cut, 2026-10-25 spec).' },
  { oldDestination: 'WorkspaceStart', newRoute: 'home', status: 'partial', owner: '#2856/#2939', note: 'Session creation is available from the connected home screen.' },
  { oldDestination: 'ReorderWorkspaces', newRoute: 'pending-workspaces', status: 'removed', owner: '#2925', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'Tree', newRoute: 'home', status: 'partial', owner: '#2925/#2856', note: 'The current session list is the interim landing surface.' },
  { oldDestination: 'Session', newRoute: 'home', status: 'removed', owner: '#2856', note: 'Removed with the terminal surface (chat-only cut, 2026-10-25 spec).' },
  { oldDestination: 'Files', newRoute: 'files', status: 'removed', owner: '#2858', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'FileViewer', newRoute: 'files', status: 'removed', owner: '#2858', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'Ports', newRoute: 'ports', status: 'removed', owner: '#2859', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'TunnelDetail', newRoute: 'ports', status: 'removed', owner: '#2859', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'AddTunnel', newRoute: 'ports', status: 'removed', owner: '#2859', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'HostForm', newRoute: 'home', status: 'partial', owner: '#2924/#2860', note: 'Current connection fields are in memory; saved host add/edit and migration remain pending.' },
  { oldDestination: 'SshKeys', newRoute: 'keys', status: 'available', owner: '#2926', note: 'JS-owned key management imports or generates keys in the Android encrypted vault and exposes only opaque handles and public metadata.' },
  { oldDestination: 'WorkspaceRoots', newRoute: 'pending-workspaces', status: 'removed', owner: '#2925', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'AddWorkspaceRoot', newRoute: 'pending-workspaces', status: 'removed', owner: '#2925', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'ClearReports', newRoute: 'diagnostics-clear', status: 'removed', owner: '#2861', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'Language', newRoute: 'settings-voice', status: 'removed', owner: '#2857', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
  { oldDestination: 'Grace', newRoute: 'settings-connections', status: 'removed', owner: '#2861', note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).' },
];

export const REQUIRED_OLD_DESTINATIONS = DESTINATION_INVENTORY.map((entry) => entry.oldDestination);
