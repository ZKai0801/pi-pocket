import {
  classifyFileByName,
  classifyFileBytes,
  composeAttachmentFilename,
  createAttachmentUploadProgressTracker,
  decideAttachmentStage,
  evaluateFileEditSave,
  formatBytes,
  isEditableFileKind,
  isRemotePathWithin,
  joinRemoteChildPath,
  looksLikeRemoteText,
  normalizeRemotePath,
  parentRemotePath,
  planAttachmentRetention as planCoreAttachmentRetention,
  remotePathName,
  resolveRemotePath,
  sanitizeAttachmentScope,
  sanitizeFilename,
  sortFileEntries,
  type AttachmentRetentionPolicy,
  type AttachmentStageDecision,
  type AttachmentUploadProgressSnapshot,
  type FileClassification,
  type FileEditSaveVerdict,
  type RemoteFileMetadata,
} from '@pocketshell/core';
import type {
  NativeSshCapabilityPlugin,
  SshCapabilityPlugin,
  SshConnectionRef,
  SshSftpEntry,
} from '../native/sshCapability';
import { createSftpChunkWriter, MAX_SFTP_STREAM_BYTES } from './sftpChunkWriter';

/** Ceiling for anything read into JS memory at once: the editor and previews. */
export const MAX_SFTP_FILE_BYTES = 512 * 1024;
export const DEFAULT_FILE_READ_BYTES = MAX_SFTP_FILE_BYTES;
/**
 * Ceiling for an upload. Uploads stream in offset-addressed chunks, so they are
 * not bounded by what one bridge call can carry — only by this total.
 */
export const MAX_SFTP_UPLOAD_BYTES = MAX_SFTP_STREAM_BYTES;
/**
 * Below this an upload is one `sftpWrite` round trip. Above it the chunked
 * path is used, because a single bridge call cannot carry more than this.
 */
export const SINGLE_SHOT_UPLOAD_BYTES = 512 * 1024;

export type FileWorkspaceEntryType = 'directory' | 'file' | 'symlink' | 'other';

export interface FileWorkspaceEntry {
  path: string;
  name: string;
  type: FileWorkspaceEntryType;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedEpochMs: number;
  classification: FileClassification | null;
}

export interface FileWorkspaceConfiguration {
  connection: SshConnectionRef;
  /** Lexical browse boundary, normally the remote home directory. */
  rootDirectory: string;
  initialDirectory?: string;
  homeDirectory?: string | null;
  /** False means this controller's SSH generation has gone stale. */
  isCurrent?: () => boolean;
  /** Test seam and operation correlation hook; values must be unique. */
  nextRequestId?: () => string;
}

export interface FileWorkspaceListing {
  path: string;
  entries: FileWorkspaceEntry[];
}

export interface FileReadResult {
  path: string;
  bytes: Uint8Array;
  classification: FileClassification;
  metadata: RemoteFileMetadata;
}

export interface FileEditSnapshot {
  path: string;
  text: string;
  classification: FileClassification;
  metadata: RemoteFileMetadata;
}

export type FileEditSaveResult =
  | { status: 'saved'; path: string; bytesWritten: number }
  | { status: 'conflict'; path: string; verdict: Exclude<FileEditSaveVerdict, 'unchanged'> };

export interface FileUploadResult {
  path: string;
  bytesWritten: number;
}

export interface AttachmentSource {
  name: string;
  bytes: Uint8Array;
  /** Total size, when `bytes` is not the whole file. Defaults to its length. */
  sizeBytes?: number;
  /**
   * Pull bytes on demand. Lets a picker hand over a large file without it ever
   * being buffered whole in JS; absent means `bytes` is the entire content.
   */
  read?: (offset: number, maxBytes: number) => Promise<Uint8Array>;
}

export interface StagedAttachment {
  path: string;
  filename: string;
  sourceName: string;
  sizeBytes: number;
}

export interface AttachmentStageFailure {
  sourceName: string;
  message: string;
}

export interface AttachmentStageResult {
  directory: string;
  decision: AttachmentStageDecision<StagedAttachment>;
  failures: AttachmentStageFailure[];
}

/**
 * One acknowledged step of a staging batch.
 *
 * Every byte advance here comes from a native write ack (core's
 * `createAttachmentUploadProgressTracker` enforces that), so this is a
 * measurement of what the host has, never an estimate from elapsed time. That
 * matters on a phone: a progress bar that predicts is a progress bar that lies
 * when the link stalls, and this one is the only feedback a 5 MB upload has.
 *
 * `fileIndex`/`fileCount` address the BATCH, while a single file's own byte
 * counts are `fileBytesWritten`/`fileBytesTotal`.
 */
export interface AttachmentUploadProgress extends Omit<AttachmentUploadProgressSnapshot, 'completedFileCount'> {
  /** How many earlier files of the batch already finished. */
  completedFileCount: number;
}

export interface AttachmentRetentionPlan {
  directory: string;
  pathsToDelete: string[];
}

export type FileWorkspaceErrorCode =
  | 'invalid-path'
  | 'outside-root'
  | 'stale-generation'
  | 'invalid-request-id'
  | 'invalid-response'
  | 'invalid-entry'
  | 'not-found'
  | 'not-file'
  | 'not-directory'
  | 'symlink-unsupported'
  | 'file-too-large'
  | 'file-changed'
  | 'not-editable'
  | 'binary-content'
  | 'invalid-utf8'
  | 'file-exists'
  | 'invalid-content';

export class FileWorkspaceError extends Error {
  constructor(readonly code: FileWorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'FileWorkspaceError';
  }
}

/**
 * Bind portable file policy to the native SFTP byte-I/O capability. Paths are
 * normalized and confined lexically under rootDirectory. The native adapter
 * also canonicalizes every operation under the configured root and rejects
 * symbolic links and special files. SFTP has no portable no-follow open or
 * metadata compare-and-swap; this cannot coordinate an external process that
 * mutates the same inode after the native handle check.
 */
export function createFileWorkspaceService(
  capability: SshCapabilityPlugin,
  configuration: FileWorkspaceConfiguration,
) {
  let requestSequence = 0;
  let currentDirectory: string;

  const homeDirectory = configuration.homeDirectory ?? null;
  const rootDirectory = resolveRemotePath(configuration.rootDirectory, '/', homeDirectory);
  if (rootDirectory == null) throw new FileWorkspaceError('invalid-path', 'The file workspace root is invalid.');
  const rootPath = normalizeRemotePath(rootDirectory);
  if (rootPath == null) throw new FileWorkspaceError('invalid-path', 'The file workspace root is invalid.');
  const normalizedRoot: string = rootPath;
  const fileCapability = capability as SshCapabilityPlugin &
    Pick<NativeSshCapabilityPlugin, 'sftpWriteIfUnchanged' | 'sftpWriteChunk' | 'sftpDelete'>;
  const chunkWriter = createSftpChunkWriter(fileCapability);
  currentDirectory = resolvePath(configuration.initialDirectory ?? normalizedRoot, normalizedRoot);

  function assertCurrent(): void {
    if (configuration.isCurrent?.() === false) {
      throw new FileWorkspaceError('stale-generation', 'The SSH connection generation is no longer current.');
    }
  }

  function nextRequestId(): string {
    assertCurrent();
    const requestId = configuration.nextRequestId?.() ?? defaultRequestId(++requestSequence);
    if (typeof requestId !== 'string' || requestId.trim() === '') {
      throw new FileWorkspaceError('invalid-request-id', 'The file request could not be started. Try again.');
    }
    return requestId;
  }

  function resolvePath(path: string, base = currentDirectory): string {
    const resolved = resolveRemotePath(path, base, homeDirectory);
    if (resolved == null) throw new FileWorkspaceError('invalid-path', 'The remote path cannot be resolved safely.');
    if (!isRemotePathWithin(normalizedRoot, resolved)) {
      throw new FileWorkspaceError('outside-root', 'The remote path is outside the configured file workspace root.');
    }
    return resolved;
  }

  function fileParts(path: string): { path: string; directory: string; name: string } {
    const resolved = resolvePath(path);
    const name = remotePathName(resolved);
    const directory = parentRemotePath(resolved);
    if (resolved === '/' || name == null || name === '/' || directory == null) {
      throw new FileWorkspaceError('invalid-path', 'A file path must name a child of a remote directory.');
    }
    return { path: resolved, directory, name };
  }

  function requestOptions(path: string) {
    return { ...configuration.connection, requestId: nextRequestId(), rootPath: normalizedRoot, path };
  }

  async function checkedResponse<T extends { requestId: string }>(
    pending: Promise<T>,
    requestId: string,
  ): Promise<T> {
    const response = await pending;
    assertCurrent();
    if (typeof response !== 'object' || response === null || response.requestId !== requestId) {
      throw new FileWorkspaceError('invalid-response', 'The server sent an unexpected reply. Try again.');
    }
    return response;
  }

  function entryType(entry: SshSftpEntry): FileWorkspaceEntryType {
    const richer = entry as SshSftpEntry & {
      type?: unknown;
      isSymlink?: unknown;
      isSymbolicLink?: unknown;
    };
    if (richer.type === 'symlink' || richer.isSymlink === true || richer.isSymbolicLink === true) {
      return 'symlink';
    }
    if (richer.type === 'other') return 'other';
    if (richer.type === 'directory' || richer.type === 'dir') {
      return entry.isDirectory === true ? 'directory' : 'other';
    }
    if (richer.type === 'file') return entry.isDirectory === false ? 'file' : 'other';
    if (richer.type != null) return 'other';
    return 'other';
  }

  function entrySize(entry: SshSftpEntry): number {
    return Number.isFinite(entry.sizeBytes) && entry.sizeBytes >= 0 ? entry.sizeBytes : Number.NaN;
  }

  function entryModified(entry: SshSftpEntry): number {
    return Number.isFinite(entry.modifiedEpochMs) && entry.modifiedEpochMs > 0
      ? entry.modifiedEpochMs
      : 0;
  }

  function mapEntry(directory: string, entry: SshSftpEntry): FileWorkspaceEntry {
    if (typeof entry.name !== 'string') {
      throw new FileWorkspaceError('invalid-entry', 'The folder listing contained an unreadable name.');
    }
    const child = joinRemoteChildPath(directory, entry.name);
    if (!child.ok) {
      throw new FileWorkspaceError('invalid-entry', `The folder listing contained an unsafe file name (${child.reason}).`);
    }
    const type = entryType(entry);
    return {
      path: child.path,
      name: entry.name,
      type,
      isDirectory: type === 'directory',
      sizeBytes: entrySize(entry),
      modifiedEpochMs: entryModified(entry),
      classification: type === 'file' ? classifyFileByName(entry.name) : null,
    };
  }

  async function listDirectoryAt(path: string): Promise<FileWorkspaceListing> {
    const directory = resolvePath(path);
    const options = requestOptions(directory);
    const response = await checkedResponse(capability.sftpList(options), options.requestId);
    if (!Array.isArray(response.entries)) {
      throw new FileWorkspaceError('invalid-response', 'The folder listing could not be read.');
    }

    const mapped: FileWorkspaceEntry[] = [];
    const seenNames = new Set<string>();
    for (const rawEntry of response.entries as unknown[]) {
      if (typeof rawEntry !== 'object' || rawEntry === null) {
        throw new FileWorkspaceError('invalid-entry', 'The folder listing contained an unreadable entry.');
      }
      const entry = rawEntry as SshSftpEntry;
      if (entry.name === '.' || entry.name === '..') continue;
      if (typeof entry.name === 'string' && seenNames.has(entry.name)) {
        throw new FileWorkspaceError('invalid-entry', 'The folder listing contained the same name twice.');
      }
      mapped.push(mapEntry(directory, entry));
      seenNames.add(entry.name);
    }
    const sortable = mapped.map((entry) => ({
      entry,
      name: entry.name,
      type: entry.type === 'directory' ? 'dir' as const : 'file' as const,
    }));
    const entries = sortFileEntries(sortable).map(({ entry }) => entry);
    return { path: directory, entries };
  }

  async function entryAt(path: string): Promise<FileWorkspaceEntry | null> {
    const parts = fileParts(path);
    const listing = await listDirectoryAt(parts.directory);
    return listing.entries.find((entry) => entry.name === parts.name) ?? null;
  }

  function assertNotSymlink(entry: FileWorkspaceEntry): void {
    if (entry.type === 'symlink') {
      throw new FileWorkspaceError('symlink-unsupported', 'Symbolic links cannot be opened safely here.');
    }
    if (entry.type === 'other') {
      throw new FileWorkspaceError('not-file', 'The remote entry type cannot be verified safely.');
    }
  }

  function metadataOf(entry: FileWorkspaceEntry): RemoteFileMetadata {
    return {
      isDirectory: entry.isDirectory,
      sizeBytes: entry.sizeBytes,
      modifiedEpochMs: entry.modifiedEpochMs,
    };
  }

  function decodeBase64(value: unknown): Uint8Array {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new FileWorkspaceError('invalid-response', 'The server sent file contents that could not be read.');
    }
    let binary: string;
    try {
      binary = atob(value);
    } catch {
      throw new FileWorkspaceError('invalid-response', 'The server sent file contents that could not be read.');
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkBytes = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  function checkByteLimit(bytes: Uint8Array, limit = MAX_SFTP_FILE_BYTES, label = 'transfer'): void {
    if (!(bytes instanceof Uint8Array)) {
      throw new FileWorkspaceError('invalid-content', 'SFTP content must be a byte array.');
    }
    if (bytes.byteLength > limit) {
      throw new FileWorkspaceError(
        'file-too-large',
        `This file is larger than the ${formatBytes(limit)} ${label} limit.`,
      );
    }
  }

  async function writeBytes(
    path: string,
    bytes: Uint8Array,
    createOnly = true,
    onProgress?: (bytesWritten: number) => void,
  ): Promise<FileUploadResult> {
    checkByteLimit(bytes, MAX_SFTP_UPLOAD_BYTES, 'upload');
    if (bytes.byteLength > SINGLE_SHOT_UPLOAD_BYTES) {
      const streamed = await chunkWriter.write({
        connection: configuration.connection,
        rootPath: normalizedRoot,
        path,
        sizeBytes: bytes.byteLength,
        read: async (offset, maxBytes) => bytes.subarray(offset, Math.min(offset + maxBytes, bytes.byteLength)),
        isCancelled: () => configuration.isCurrent?.() === false,
        ...(onProgress === undefined ? {} : { onProgress }),
      });
      assertCurrent();
      return { path, bytesWritten: streamed.bytesWritten };
    }
    const options = { ...requestOptions(path), createOnly, dataBase64: encodeBase64(bytes) };
    const response = await checkedResponse(capability.sftpWrite(options), options.requestId);
    if (!Number.isSafeInteger(response.bytesWritten) || response.bytesWritten !== bytes.byteLength) {
      throw new FileWorkspaceError('invalid-response', 'The server did not confirm the whole file was written.');
    }
    return { path, bytesWritten: response.bytesWritten };
  }

  /**
   * Stage one attachment. A source carrying `read` is streamed chunk by chunk,
   * so a multi-megabyte pick never has to exist whole in JS memory; an empty
   * file still takes the single-shot path because a zero-byte stream has no
   * chunks to send.
   */
  async function writeAttachment(
    path: string,
    source: AttachmentSource,
    sizeBytes: number,
    onProgress?: (bytesWritten: number) => void,
  ): Promise<FileUploadResult> {
    if (source.read && sizeBytes > 0) {
      const streamed = await chunkWriter.write({
        connection: configuration.connection,
        rootPath: normalizedRoot,
        path,
        sizeBytes,
        read: source.read,
        isCancelled: () => configuration.isCurrent?.() === false,
        ...(onProgress === undefined ? {} : { onProgress }),
      });
      assertCurrent();
      return { path, bytesWritten: streamed.bytesWritten };
    }
    return writeBytes(path, source.bytes, true, onProgress);
  }

  /**
   * Remove one regular file. A missing path is success — the caller is a
   * pruner working from a listing it read moments ago, and "already gone" is
   * the outcome it wanted.
   *
   * A symlink is refused rather than followed: the pruner only ever names
   * files the host listed inside the staging directory, so a link there means
   * the directory was changed under us, and following it could remove
   * something outside the tree.
   */
  async function deleteFile(path: string): Promise<void> {
    const parts = fileParts(path);
    const entry = await entryAt(parts.path);
    if (entry == null) return;
    assertNotSymlink(entry);
    if (entry.type !== 'file') {
      throw new FileWorkspaceError('not-file', 'Only regular files can be removed from the staging directory.');
    }
    const options = requestOptions(parts.path);
    await checkedResponse(fileCapability.sftpDelete(options), options.requestId);
  }

  async function readFile(path: string, maxBytes = DEFAULT_FILE_READ_BYTES): Promise<FileReadResult> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SFTP_FILE_BYTES) {
      throw new FileWorkspaceError('file-too-large', `The read limit must be between 1 byte and ${formatBytes(MAX_SFTP_FILE_BYTES)}.`);
    }
    const parts = fileParts(path);
    const entry = await entryAt(parts.path);
    if (entry == null) throw new FileWorkspaceError('not-found', 'The remote file does not exist.');
    assertNotSymlink(entry);
    if (entry.type !== 'file') throw new FileWorkspaceError('not-file', 'The remote path is not a regular file.');
    if (!Number.isFinite(entry.sizeBytes)) {
      throw new FileWorkspaceError('invalid-response', 'The remote file size could not be verified.');
    }
    if (entry.sizeBytes > maxBytes) {
      throw new FileWorkspaceError('file-too-large', `The remote file exceeds the ${maxBytes} byte read limit.`);
    }

    const options = { ...requestOptions(parts.path), maxBytes };
    const response = await checkedResponse(capability.sftpRead(options), options.requestId);
    const bytes = decodeBase64(response.dataBase64);
    if (bytes.byteLength !== entry.sizeBytes) {
      throw new FileWorkspaceError('file-changed', 'The remote file size changed while it was being read.');
    }
    return {
      path: parts.path,
      bytes,
      classification: classifyFileBytes(classifyFileByName(parts.path), bytes),
      metadata: metadataOf(entry),
    };
  }

  async function loadTextForEdit(path: string, maxBytes = DEFAULT_FILE_READ_BYTES): Promise<FileEditSnapshot> {
    const loaded = await readFile(path, maxBytes);
    if (!isEditableFileKind(loaded.classification.kind)) {
      throw new FileWorkspaceError('not-editable', 'This file type does not support text editing.');
    }
    if (!looksLikeRemoteText(loaded.bytes)) {
      throw new FileWorkspaceError('binary-content', 'The file contents do not look like safe UTF-8 text.');
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
    } catch {
      throw new FileWorkspaceError('invalid-utf8', 'The remote text file is not valid UTF-8.');
    }

    const current = await entryAt(loaded.path);
    if (current == null || current.type !== 'file') {
      if (current?.type === 'symlink') assertNotSymlink(current);
      throw new FileWorkspaceError('file-changed', 'The remote file changed while it was being opened for editing.');
    }
    const verdict = evaluateFileEditSave(loaded.metadata, metadataOf(current));
    if (verdict !== 'unchanged') {
      throw new FileWorkspaceError('file-changed', 'The remote file changed while it was being opened for editing.');
    }
    return {
      path: loaded.path,
      text,
      classification: loaded.classification,
      metadata: metadataOf(current),
    };
  }

  /**
   * Create `directory` and every missing ancestor below the workspace root.
   *
   * `~/.pocketshell/attachments` does not exist on a host that has never
   * received an attachment, and a single-level mkdir cannot make it: probing
   * an entry lists its PARENT, so a missing parent throws before any mkdir is
   * issued. Walking down from the root keeps that invariant — at each step the
   * parent was just ensured — at the cost of one listing per level, which for a
   * staging directory is two.
   */
  async function ensureDirectoryTree(directory: string): Promise<void> {
    const target = normalizeRemotePath(directory);
    if (target == null || !isRemotePathWithin(normalizedRoot, target)) {
      throw new FileWorkspaceError('outside-root', 'The remote path is outside the configured file workspace root.');
    }
    const prefix = normalizedRoot === '/' ? 1 : normalizedRoot.length + 1;
    const rest = target === normalizedRoot ? '' : target.slice(prefix);
    let current = normalizedRoot;
    for (const segment of rest.split('/').filter(Boolean)) {
      const child = joinRemoteChildPath(current, segment);
      if (!child.ok) throw new FileWorkspaceError('invalid-path', 'The remote path cannot be created safely.');
      current = child.path;
      const existing = await entryAt(current);
      if (existing == null) {
        const options = requestOptions(current);
        await checkedResponse(capability.sftpMkdir(options), options.requestId);
        continue;
      }
      assertNotSymlink(existing);
      if (!existing.isDirectory) {
        throw new FileWorkspaceError('not-directory', 'A part of the attachment staging path is not a directory.');
      }
    }
  }

  async function uploadAttachmentBatch(input: {
    directory: string;
    scopeKey: string;
    timestamp: string;
    attachments: readonly AttachmentSource[];
    isCancelled?: () => boolean;
    /** Called on every acknowledged write step, for the composer's progress bar. */
    onProgress?: (progress: AttachmentUploadProgress) => void;
  }): Promise<AttachmentStageResult> {
    const base = resolvePath(input.directory);
    const scope = sanitizeAttachmentScope(input.scopeKey);
    const folder = joinRemoteChildPath(base, scope);
    if (!folder.ok) {
      throw new FileWorkspaceError('invalid-path', 'The attachment staging directory is invalid.');
    }
    if (!isRemotePathWithin(normalizedRoot, folder.path)) {
      throw new FileWorkspaceError('invalid-path', 'The attachment staging directory is invalid.');
    }
    const directory = folder.path;
    const attempts: Array<{ kind: 'uploaded'; attachment: StagedAttachment } | { kind: 'failed' }> = [];
    const failures: AttachmentStageFailure[] = [];

    if (input.isCancelled?.() === true) {
      return { directory, decision: decideAttachmentStage([], true), failures };
    }
    if (input.attachments.length === 0) {
      return { directory, decision: decideAttachmentStage([]), failures };
    }
    const prepared = input.attachments.map((source, index) => ({
      source,
      filename: composeAttachmentFilename(input.timestamp, index, sanitizeFilename(source.name)),
      sizeBytes: source.bytes instanceof Uint8Array
        ? (source.sizeBytes ?? source.bytes.byteLength)
        : Number.NaN,
    }));
    // Bounds first, then progress: a batch containing an oversized file still
    // reports the files that CAN land, so the total is the sum of those.
    const batchBytesTotal = prepared.reduce(
      (total, item) => (Number.isSafeInteger(item.sizeBytes) && item.sizeBytes > 0 ? total + item.sizeBytes : total),
      0,
    );
    let completedBytes = 0;
    let completedFiles = 0;
    await ensureDirectoryTree(folder.path);
    const initialListing = await listDirectoryAt(directory);
    const occupiedNames = new Set(initialListing.entries.map((entry) => entry.name));

    for (const [index, { source, filename, sizeBytes }] of prepared.entries()) {
      if (input.isCancelled?.() === true) {
        return { directory, decision: decideAttachmentStage(attempts, true), failures };
      }

      const child = joinRemoteChildPath(directory, filename);
      if (!child.ok) {
        attempts.push({ kind: 'failed' });
        failures.push({ sourceName: source.name, message: 'The attachment name could not be made into a safe remote path.' });
        continue;
      }
      if (!isRemotePathWithin(normalizedRoot, child.path)) {
        attempts.push({ kind: 'failed' });
        failures.push({ sourceName: source.name, message: 'The attachment name could not be made into a safe remote path.' });
        continue;
      }
      if (occupiedNames.has(filename)) {
        attempts.push({ kind: 'failed' });
        failures.push({ sourceName: source.name, message: 'An attachment with this generated name already exists.' });
        continue;
      }
      if (!(source.bytes instanceof Uint8Array)
        || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_SFTP_UPLOAD_BYTES) {
        attempts.push({ kind: 'failed' });
        failures.push({
          sourceName: source.name,
          message: source.bytes instanceof Uint8Array
            ? `This file is larger than the ${formatBytes(MAX_SFTP_UPLOAD_BYTES)} upload limit.`
            : 'Attachment content must be a byte array.',
        });
        continue;
      }

      // One tracker per FILE, not per batch: core's tracker advances its active
      // index only on `complete`, and a failed file must not stop the progress
      // of the ones after it (the batch keeps going on purpose). The batch
      // totals are accumulated here instead, from the same acknowledged counts.
      const tracker = createAttachmentUploadProgressTracker([{ name: source.name, sizeBytes }]);
      const report = (fileBytesWritten: number, completedFileCount: number): void => {
        input.onProgress?.({
          fileName: source.name,
          fileIndex: index,
          fileCount: prepared.length,
          fileBytesWritten,
          fileBytesTotal: sizeBytes,
          batchBytesWritten: completedBytes + fileBytesWritten,
          batchBytesTotal,
          completedFileCount,
        });
      };

      try {
        const uploaded = await writeAttachment(child.path, source, sizeBytes, (written) => {
          const step = tracker.report(0, written, sizeBytes);
          if (step !== null) report(step.fileBytesWritten, completedFiles);
        });
        const attachment = {
          path: uploaded.path,
          filename,
          sourceName: source.name,
          sizeBytes: uploaded.bytesWritten,
        };
        attempts.push({ kind: 'uploaded', attachment });
        occupiedNames.add(filename);
        // A single-shot write has no intermediate reports at all, so the final
        // ack is the only thing that can move the bar — and it always should.
        tracker.complete(0, uploaded.bytesWritten);
        report(uploaded.bytesWritten, completedFiles);
        completedBytes += uploaded.bytesWritten;
        completedFiles += 1;
      } catch (error) {
        assertCurrent();
        tracker.fail(0);
        attempts.push({ kind: 'failed' });
        failures.push({ sourceName: source.name, message: errorMessage(error) });
      }
    }

    return { directory, decision: decideAttachmentStage(attempts), failures };
  }

  async function planRetention(
    directory: string,
    nowMillis: number,
    policy?: AttachmentRetentionPolicy,
  ): Promise<AttachmentRetentionPlan> {
    const listing = await listDirectoryAt(directory);
    const retentionEntries = listing.entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      type: entry.type === 'directory'
        ? 'dir' as const
        : entry.type === 'symlink'
          ? 'symlink' as const
          : entry.type === 'other'
            ? 'other' as const
            : 'file' as const,
      modifyTime: entry.modifiedEpochMs,
    }));
    const plan = planCoreAttachmentRetention(retentionEntries, nowMillis, policy);
    return { directory: listing.path, pathsToDelete: plan.delete.map((entry) => entry.path) };
  }

  return {
    get rootDirectory() { return normalizedRoot; },
    get currentDirectory() { return currentDirectory; },
    resolvePath,
    async listDirectory(path = currentDirectory): Promise<FileWorkspaceListing> {
      return listDirectoryAt(path);
    },
    async navigate(path: string): Promise<FileWorkspaceListing> {
      const listing = await listDirectoryAt(path);
      currentDirectory = listing.path;
      return listing;
    },
    readFile,
    loadTextForEdit,
    async saveText(snapshot: FileEditSnapshot, text: string): Promise<FileEditSaveResult> {
      const parts = fileParts(snapshot.path);
      if (snapshot.metadata.isDirectory || snapshot.metadata.modifiedEpochMs <= 0) {
        return { status: 'conflict', path: parts.path, verdict: 'changed' };
      }
      const bytes = new TextEncoder().encode(text);
      checkByteLimit(bytes);
      const options = {
        ...requestOptions(parts.path),
        expectedMetadata: {
          isDirectory: false as const,
          sizeBytes: snapshot.metadata.sizeBytes,
          modifiedEpochMs: snapshot.metadata.modifiedEpochMs,
        },
        dataBase64: encodeBase64(bytes),
      };
      const response = await checkedResponse(
        fileCapability.sftpWriteIfUnchanged(options),
        options.requestId,
      );
      if (response.status === 'conflict') {
        if (response.verdict !== 'missing' && response.verdict !== 'changed') {
          throw new FileWorkspaceError('invalid-response', 'The server sent an unexpected reply while saving. Try again.');
        }
        return { status: 'conflict', path: parts.path, verdict: response.verdict };
      }
      if (response.status !== 'written' || !Number.isSafeInteger(response.bytesWritten) || response.bytesWritten !== bytes.byteLength) {
        throw new FileWorkspaceError('invalid-response', 'The server did not confirm the save. Try again.');
      }
      return { status: 'saved', path: parts.path, bytesWritten: response.bytesWritten };
    },
    async writeFile(path: string, bytes: Uint8Array, overwrite = false): Promise<FileUploadResult> {
      const parts = fileParts(path);
      const existing = await entryAt(parts.path);
      if (existing != null) {
        assertNotSymlink(existing);
        if (existing.type !== 'file') throw new FileWorkspaceError('not-file', 'The upload target is not a regular file.');
        if (!overwrite) throw new FileWorkspaceError('file-exists', 'The remote upload target already exists.');
      }
      return writeBytes(parts.path, bytes, !overwrite);
    },
    stageAttachments: uploadAttachmentBatch,
    planAttachmentRetention: planRetention,
    deleteFile,
  };
}

function defaultRequestId(sequence: number): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 12);
  return `files-${Date.now().toString(36)}-${sequence.toString(36)}-${random}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}
