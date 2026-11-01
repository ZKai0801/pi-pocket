import { registerPlugin, type Plugin } from '@capacitor/core';
import {
  readSshCapabilityError,
  type SshCapability,
  type SshResourceSnapshot,
  type SshSftpOptions,
} from '@pocketshell/core';

export type {
  SshAck,
  SshConnectOptions,
  SshConnectResult,
  SshConnectionRef,
  SshConnectionStateEvent,
  SshCancellationOptions,
  SshCancellationResult,
  SshCancellationTarget,
  SshCredential,
  SshExecOptions,
  SshExecResult,
  SshHostTarget,
  SshPtyOpenOptions,
  SshPtyReadOptions,
  SshPtyReadResult,
  SshPtyRef,
  SshPtyResizeOptions,
  SshPtyWriteOptions,
  SshPortForwardOptions,
  SshPortForwardRef,
  SshResourceSnapshot,
  SshSftpEntry,
  SshSftpOptions,
  SshSftpWriteOptions,
  HostKeyTrustPin,
  PresentedHostKey,
} from '@pocketshell/core';
export { SshCapabilityError } from '@pocketshell/core';

export interface NativeSftpExpectedMetadata {
  isDirectory: false;
  sizeBytes: number;
  modifiedEpochMs: number;
}

/**
 * `sftpRead` options plus the Android plugin's optional byte `offset`, used to
 * page through a large file instead of head-truncating it. The pinned core
 * contract does not carry the field; the native plugin reads it when present
 * and every other platform ignores the extra key.
 */
export interface SftpReadWithOffsetOptions extends SshSftpOptions {
  maxBytes: number;
  offset?: number;
}

/**
 * One bounded chunk of a streaming write.
 *
 * Like `SftpReadWithOffsetOptions.offset`, this is an Android-only addition:
 * the pinned core contract carries no chunked write, the native plugin reads
 * the method when present, and every other platform simply never calls it.
 * The write is stateless — `offset` and the native size check are the whole
 * sequencing mechanism, so no handle is held between calls.
 */
export interface SftpWriteChunkOptions extends SshSftpOptions {
  /** Remote root the path is resolved under, as `sftpWrite` carries it. */
  rootPath?: string;
  /** Byte offset the chunk must land at; the native side rejects a mismatch. */
  offset: number;
  /** Declared total size of the file; a chunk may never run past it. */
  totalBytes: number;
  /** Refuse to write over an existing file on the first chunk. */
  createOnly?: boolean;
  dataBase64: string;
}

export interface SftpWriteChunkResult {
  requestId: string;
  offset: number;
  bytesWritten: number;
  /** Remote size after this chunk, i.e. `offset + bytesWritten`. */
  size: number;
}

export interface NativeSftpWriteIfUnchangedOptions {
  requestId: string;
  connectionId: string;
  generationId: string;
  rootPath: string;
  path: string;
  expectedMetadata: NativeSftpExpectedMetadata;
  dataBase64: string;
}

export interface NativeSftpWriteIfUnchangedResult {
  requestId: string;
  status: 'written' | 'conflict';
  verdict?: 'missing' | 'changed';
  bytesWritten?: number;
}

/** Mirrors the plugin's request/ack pair; `path` may name a file or a directory. */
export interface NativeSftpDeleteOptions extends SshSftpOptions {
  path: string;
}

export interface NativeSftpDeleteResult {
  requestId: string;
}

/** One pushed event of a long-lived exec channel (the RPC transport). */
export interface NativeStreamEvent {
  channelId: string;
  connectionId: string;
  generationId: string;
  kind: 'stdout' | 'exit';
  /** Present when the event carries bytes; absent on `exit`. */
  dataBase64?: string;
  /** Present on `exit` when the remote command reported one. */
  exitCode?: number | null;
}

export interface NativeSshStreamOpenOptions {
  requestId: string;
  connectionId: string;
  generationId: string;
  command: string;
}

export interface NativeSshStreamOpenResult {
  requestId: string;
  connectionId: string;
  generationId: string;
  channelId: string;
}

export interface NativeSshStreamChannelOptions {
  requestId: string;
  channelId: string;
}

/** Capacitor registration for the platform-neutral core effects contract. */
export type SshCapabilityPlugin = Plugin & SshCapability;

/** Capacitor plugin method arguments must be objects; the core contract uses a request ID. */
export type NativeSshCapabilityPlugin = Plugin & {
  resourceSnapshot(options: { requestId: string }): Promise<unknown>;
  /** What this build's native `connect()` can dial beyond direct TCP (#3086). */
  transportCapabilities(options: { requestId: string }): Promise<unknown>;
  sftpWriteIfUnchanged(
    options: NativeSftpWriteIfUnchangedOptions,
  ): Promise<NativeSftpWriteIfUnchangedResult>;
  /** Android-only chunked write; absent on every other platform. */
  sftpWriteChunk(options: SftpWriteChunkOptions): Promise<SftpWriteChunkResult>;
  /**
   * Delete a file or an empty directory. Present on the native side since the
   * Kotlin build (#2857's attachment retention), but not part of core's
   * `SshCapability` contract — the phone is the only surface that prunes.
   */
  sftpDelete(options: NativeSftpDeleteOptions): Promise<NativeSftpDeleteResult>;
  /**
   * A long-lived exec channel: opened once, read by pushed events. Android
   * only — the pinned core contract has no streaming exec, and every other
   * platform simply never calls these.
   */
  openStream(options: NativeSshStreamOpenOptions): Promise<NativeSshStreamOpenResult>;
  writeStream(options: NativeSshStreamChannelOptions & { dataBase64: string }): Promise<{ requestId: string; channelId: string }>;
  closeStream(options: NativeSshStreamChannelOptions): Promise<{ requestId: string; channelId: string }>;
};

function isResourceSnapshot(value: unknown, requestId: string): value is SshResourceSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.requestId !== requestId) return false;
  return ['connections', 'ptys', 'sftpClients', 'forwards'].every((key) => {
    const count = snapshot[key];
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  });
}

/**
 * SshCapabilityPlugin.MAX_CHANNELS_PER_CONNECTION: the plugin refuses a
 * channel past this many per connection (PTYs, execs and forwards share it).
 * Stated to core so the controller bounds its PTYs below it (#2955).
 */
export const NATIVE_MAX_CHANNELS_PER_CONNECTION = 8;

/**
 * The transports the NATIVE plugin reported it can dial (#3086). Core reads
 * `SshCapability.gatewayTransport` at dial time; it is answered from here,
 * which only {@link loadNativeTransportCapabilities} sets, from the native
 * plugin's own reply. False until then and after any unreadable reply, so a
 * build or a bridge that does not report the gateway transport can never be
 * treated as having it. The Android platform boundary
 * (`unsupportedTransportMessage`) admits gateway hosts on the same report.
 */
export interface NativeTransportCapabilities {
  gatewayTransport: boolean;
}

/** Adapt the core's string request ID to Capacitor's one-object plugin bridge. */
export function adaptSshCapabilityPlugin(
  plugin: NativeSshCapabilityPlugin,
  transports: NativeTransportCapabilities = { gatewayTransport: false },
): SshCapabilityPlugin {
  return new Proxy(plugin, {
    get(target, property) {
      // Plain values, answered here: Capacitor's plugin proxy would turn any
      // unknown property into a native method call.
      if (property === 'maxChannelsPerConnection') return NATIVE_MAX_CHANNELS_PER_CONNECTION;
      if (property === 'gatewayTransport') return transports.gatewayTransport;
      if (property === 'resourceSnapshot') {
        return async (requestId: string): Promise<SshResourceSnapshot> => {
          const call = Reflect.get(target, property, target) as NativeSshCapabilityPlugin['resourceSnapshot'];
          const snapshot = await call.call(target, { requestId });
          if (!isResourceSnapshot(snapshot, requestId)) {
            throw new Error('The connection status reply could not be read.');
          }
          return snapshot;
        };
      }
      return Reflect.get(target, property, target);
    },
  }) as unknown as SshCapabilityPlugin;
}

function isTransportCapabilitiesReply(value: unknown, requestId: string): value is { gatewayTransport: boolean } {
  if (typeof value !== 'object' || value === null) return false;
  const reply = value as Record<string, unknown>;
  return reply.requestId === requestId && typeof reply.gatewayTransport === 'boolean';
}

let transportProbeSequence = 0;

/**
 * Ask the native plugin which transports it can dial and record the answer
 * in `transports`. Fails closed: a rejected call, a missing method (an older
 * native build, the browser dev bridge) or a malformed reply records false.
 */
export async function loadNativeTransportCapabilities(
  plugin: NativeSshCapabilityPlugin,
  transports: NativeTransportCapabilities,
): Promise<NativeTransportCapabilities> {
  transportProbeSequence += 1;
  const requestId = `transport-capabilities-${transportProbeSequence}`;
  let gatewayTransport = false;
  try {
    const reply = await plugin.transportCapabilities({ requestId });
    gatewayTransport = isTransportCapabilitiesReply(reply, requestId) && reply.gatewayTransport === true;
  } catch {
    gatewayTransport = false;
  }
  transports.gatewayTransport = gatewayTransport;
  return transports;
}

/** sshj performs physical I/O; portable policy remains in pocketshell-core. */
const nativeSshCapability = registerPlugin<NativeSshCapabilityPlugin>('SshCapability');
/** What the installed native plugin reported (see {@link loadNativeTransportCapabilities}). */
export const sshTransportCapabilities: NativeTransportCapabilities = { gatewayTransport: false };
export const sshCapability = adaptSshCapabilityPlugin(nativeSshCapability, sshTransportCapabilities);
/** Read the installed native plugin's transports into {@link sshCapability}. */
export const loadSshTransportCapabilities = () =>
  loadNativeTransportCapabilities(nativeSshCapability, sshTransportCapabilities);

/** Normalize Capacitor's plain bridge error object to the core error type. */
export const readSshError = readSshCapabilityError;

let streamRequestSequence = 0;

/** The live-connection identity a stream is opened on. */
export interface SshStreamTarget {
  connectionId: string;
  generationId: string;
}

export interface NativeStreamSession {
  channelId: string;
  /** Write to the channel's stdin. Unused by the watch, used by an RPC. */
  write(dataBase64: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Open a long-lived exec channel on the live connection.
 *
 * Android-only: the pinned core contract has no streaming exec, so this talks
 * to the plugin directly and every other platform simply never calls it.
 * Throws when the native build has no such method (an older plugin).
 */
export async function openNativeStream(
  target: SshStreamTarget,
  command: string,
): Promise<NativeStreamSession> {
  streamRequestSequence += 1;
  const requestId = `ssh-stream-${streamRequestSequence}`;
  const opened = await nativeSshCapability.openStream({ ...target, requestId, command });
  if (opened.requestId !== requestId) throw new Error('SSH stream open returned a stale request.');
  const channelId = opened.channelId;
  return {
    channelId,
    async write(dataBase64: string): Promise<void> {
      streamRequestSequence += 1;
      const writeRequestId = `ssh-stream-${streamRequestSequence}`;
      await nativeSshCapability.writeStream({ requestId: writeRequestId, channelId, dataBase64 });
    },
    async close(): Promise<void> {
      streamRequestSequence += 1;
      const closeRequestId = `ssh-stream-${streamRequestSequence}`;
      try {
        await nativeSshCapability.closeStream({ requestId: closeRequestId, channelId });
      } catch {
        // A channel the transport already took down is already closed.
      }
    },
  };
}

/**
 * Receive every open channel's pushed output. The listener is global — the
 * plugin identifies the channel on each event — and the returned function
 * removes it.
 */
export async function listenToStreamOutput(
  listener: (event: NativeStreamEvent) => void,
): Promise<() => void> {
  const handle = await nativeSshCapability.addListener('streamOutput', (event: NativeStreamEvent) => {
    listener(event);
  });
  return () => {
    void handle.remove();
  };
}
