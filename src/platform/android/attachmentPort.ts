/**
 * The Android half of `PocketShellApi['attachments']` (#2857): pick files with
 * the system picker, read them back without buffering, and stage them on the
 * host through the same SFTP workspace the Files screen uses.
 *
 * The three verbs are one flow, which is why they live together:
 *
 *   `pickFiles`  SAF multi-select; returns opaque `saf:<fileId>` handles and
 *                keeps the native URI grant open, with the name and size the
 *                picker reported, in a bounded table.
 *   `readLocal`  the whole file, for the callers that need pixels (the doodle
 *                sheet's backdrop) rather than an upload.
 *   `stage`      uploads to `~/.pocketshell/attachments/<scope>/` before the
 *                prompt is sent, and answers with tilde-form paths the composer
 *                appends to the draft.
 *
 * Two constraints shape this file:
 *
 * 1. **A photo never fits one bridge call.** `stage` hands the stager a
 *    `read(offset, maxBytes)` puller over the still-open SAF handle, so bytes
 *    travel picker → JS chunk → SFTP chunk and never exist whole in memory.
 *    That is also why the handle table remembers `sizeBytes`: the chunked
 *    writer needs the total before it starts.
 * 2. **The native SFTP calls are generation-checked.** `findConnection`
 *    rejects a ref whose `generationId` is not the live one, so the ref is
 *    read from the controller that owns the connection at the moment of use,
 *    never cached and never invented.
 */
import type { AttachmentSource as CoreAttachmentSource, StageAttachmentsResult } from '@pocketshell/core';
import { COMPOSER_STRINGS } from '@pocketshell/core/shared/composerText';
import type { PocketShellApi } from '@ui/app/api';
import type { SshCapabilityPlugin, SshConnectionRef } from '../../native/sshCapability';
import { MAX_SFTP_CHUNK_BYTES } from '../../session/sftpChunkWriter';
import {
  MAX_SFTP_UPLOAD_BYTES,
  createFileWorkspaceService,
  type AttachmentSource,
  type AttachmentUploadProgress,
} from '../../session/files';
import type { PickedAttachmentHandle } from '../../session/platformInput';

/** How many picks the handle table keeps before the oldest grant is released. */
const MAX_OPEN_PICKS = 32;

/** The `~/.pocketshell/attachments` root, below the host's home. */
const STAGING_SEGMENTS = ['.pocketshell', 'attachments'] as const;

export const SAF_HANDLE_PREFIX = 'saf:';

/** What the port needs from the picker; `platformInput` satisfies it whole. */
export interface AttachmentPicker {
  pickAttachmentHandles(options?: { multiple?: boolean }): Promise<{
    cancelled: boolean;
    handles: PickedAttachmentHandle[];
    failures: readonly { name: string; message: string }[];
    release: () => Promise<void>;
  }>;
  readAttachmentRange(fileId: string, offset: number, maxBytes: number): Promise<Uint8Array>;
}

export interface AndroidAttachmentDeps {
  picker: AttachmentPicker;
  capability: SshCapabilityPlugin;
  /**
   * The live native ref for a controller-backed connection, or null when it is
   * not connected. Read per call: the native side rejects a stale generation.
   */
  connectionRef: (connectionId: string) => SshConnectionRef | null;
  /** The host's `$HOME`, or null when the probe failed. */
  home: (connectionId: string) => Promise<string | null>;
  /** Test seam; defaults to the wall clock. */
  now?: () => Date;
}

interface OpenHandle {
  name: string;
  sizeBytes: number | null;
  mimeType: string | null;
  /** Releases this pick's native URI grants; shared by its handles. */
  release: () => Promise<void>;
}

/**
 * Build the `attachments` group for this phone.
 *
 * Every path out of `stage` is a result object rather than an exception: the
 * contract says "never thrown", and the composer renders `error` verbatim
 * under a draft it keeps.
 */
export function createAndroidAttachmentPort(deps: AndroidAttachmentDeps): PocketShellApi['attachments'] {
  const open = new Map<string, OpenHandle>();
  const now = deps.now ?? (() => new Date());

  function remember(handle: PickedAttachmentHandle, release: () => Promise<void>): string {
    const key = `${SAF_HANDLE_PREFIX}${handle.fileId}`;
    open.set(key, {
      name: handle.name,
      sizeBytes: handle.sizeBytes,
      mimeType: handle.mimeType,
      release,
    });
    // Bounded, and the eviction releases the native grant it was holding: an
    // abandoned pick costs one SAF permission, not one per pick this session.
    while (open.size > MAX_OPEN_PICKS) {
      const oldest = open.keys().next();
      if (oldest.done === true) break;
      const evicted = open.get(oldest.value);
      open.delete(oldest.value);
      void evicted?.release();
    }
    return key;
  }

  async function pickFiles(payload?: { title?: string; multiple?: boolean }): Promise<string[]> {
    // The native picker takes no title; SAF supplies its own ("Open from").
    const picked = await deps.picker.pickAttachmentHandles({ multiple: payload?.multiple !== false });
    if (picked.cancelled) return [];
    // A per-file failure (too large, unreadable) has no channel in this
    // contract — `pickFiles` answers with paths only — so the pick returns
    // whatever it could open and the rest is dropped. The size ceiling is now
    // the 64 MiB upload bound, so this is a corrupt-provider case, not a
    // routine one.
    return picked.handles.map((handle) => remember(handle, picked.release));
  }

  async function readLocal(path: string): Promise<Uint8Array> {
    const fileId = fileIdOf(path);
    if (fileId === null) {
      throw new Error('Android can only read files it picked with the system picker.');
    }
    const handle = open.get(path);
    return readWhole(fileId, handle?.sizeBytes ?? null);
  }

  async function stage(payload: {
    connectionId: string;
    scopeKey: string;
    sources: CoreAttachmentSource[];
    /** Fires on each acknowledged chunk write, for the composer's progress bar. */
    onProgress?: (progress: AttachmentUploadProgress) => void;
  }): Promise<StageAttachmentsResult> {
    const sources = Array.isArray(payload?.sources) ? payload.sources : [];
    const connectionId = typeof payload?.connectionId === 'string' ? payload.connectionId : '';
    if (connectionId === '') return failure(sources.length, 'No connection was named for this upload.');
    if (sources.length === 0) return { ok: true, paths: [], failedCount: 0 };

    const reference = deps.connectionRef(connectionId);
    if (reference === null) return failure(sources.length, 'The SSH connection is not available.');
    const home = await deps.home(connectionId);
    if (home === null) return failure(sources.length, 'The host did not report a home directory.');

    const prepared: AttachmentSource[] = [];
    const failed: { sourceName: string; message: string }[] = [];
    const releasing = new Set<OpenHandle>();
    for (const source of sources) {
      const converted = await toLocalSource(source, releasing);
      if ('message' in converted) failed.push(converted);
      else prepared.push(converted.source);
    }

    let result: Awaited<ReturnType<ReturnType<typeof createFileWorkspaceService>['stageAttachments']>> | null = null;
    let stagedError: string | null = null;
    let workspace: ReturnType<typeof createFileWorkspaceService> | null = null;
    const directory = stagingDirectory(home);
    try {
      if (directory === null) {
        stagedError = 'The attachment staging directory could not be resolved.';
      } else {
        workspace = createFileWorkspaceService(deps.capability, {
          connection: reference,
          rootDirectory: home,
          initialDirectory: home,
          homeDirectory: home,
          isCurrent: () => deps.connectionRef(connectionId)?.generationId === reference.generationId,
        });
        result = await workspace.stageAttachments({
          directory,
          scopeKey: typeof payload?.scopeKey === 'string' ? payload.scopeKey : '',
          timestamp: stamp(now()),
          attachments: prepared,
          ...(typeof payload?.onProgress === 'function' ? { onProgress: payload.onProgress } : {}),
        });
      }
    } catch (error) {
      stagedError = error instanceof Error && error.message !== '' ? error.message : String(error);
    } finally {
      for (const handle of releasing) await handle.release();
    }

    if (result === null) {
      return failure(sources.length, stagedError ?? 'The attachment upload did not finish.');
    }

    // Housekeeping runs AFTER the batch settled and never fails it: the files
    // that landed are already attached, and a prune that cannot list the
    // directory is not a reason to lose them. The directory to prune is the
    // batch's own scope folder (`result.directory`), not the shared root —
    // pruning the root would never see a file, since every upload nests one
    // level down.
    if (workspace !== null && result.decision.attachments.length > 0) {
      await pruneStaging(
        workspace,
        result.directory,
        now().getTime(),
        new Set(result.decision.attachments.map((attachment) => attachment.path)),
      );
    }

    const paths = result.decision.attachments.map((attachment) => tildePath(attachment.path, home));
    const problems = [
      ...failed.map((item) => ({ sourceName: item.sourceName, message: item.message })),
      ...result.failures.map((item) => ({ sourceName: item.sourceName, message: item.message })),
    ];
    if (problems.length === 0 && paths.length === sources.length) {
      return { ok: true, paths, failedCount: 0 };
    }
    return {
      ok: false,
      paths,
      failedCount: problems.length + Math.max(0, sources.length - paths.length - problems.length),
      error: describeFailures(problems, sources.length),
    };
  }

  /**
   * Turn one contract-level source into the byte-shaped source the stager
   * takes. A `file` source on this phone is a `saf:` handle, so its bytes are
   * pulled on demand; anything else (a desktop path that leaked through) is
   * refused rather than silently read from a filesystem the WebView cannot see.
   */
  async function toLocalSource(
    source: CoreAttachmentSource,
    releasing: Set<OpenHandle>,
  ): Promise<{ source: AttachmentSource } | { sourceName: string; message: string }> {
    if (source === null || typeof source !== 'object') {
      return { sourceName: 'Attachment', message: 'The attachment was not understood.' };
    }
    if (source.kind === 'bytes') {
      const bytes = source.data;
      if (!(bytes instanceof Uint8Array)) {
        return { sourceName: nameOf(source), message: 'The attachment had no readable bytes.' };
      }
      if (bytes.byteLength > MAX_SFTP_UPLOAD_BYTES) {
        return {
          sourceName: nameOf(source),
          message: `This file is larger than the ${MAX_SFTP_UPLOAD_BYTES}-byte upload limit.`,
        };
      }
      return { source: { name: nameOf(source), bytes } };
    }
    if (source.kind !== 'file' || typeof source.path !== 'string') {
      return { sourceName: nameOf(source), message: 'The attachment was not understood.' };
    }

    const fileId = fileIdOf(source.path);
    const handle = open.get(source.path);
    if (fileId === null || handle === undefined) {
      return {
        sourceName: source.name || 'Attachment',
        message: 'This file can no longer be read. Pick it again.',
      };
    }
    releasing.add(handle);
    open.delete(source.path);

    const name = source.name || handle.name;
    // The size is what bounding the stream needs. A provider that reported
    // none is read whole instead — the picker's own 64 MiB ceiling still
    // applies, and this is the only path that costs memory.
    if (handle.sizeBytes === null) {
      try {
        const bytes = await readWhole(fileId, null);
        return { source: { name, bytes } };
      } catch (error) {
        return {
          sourceName: name,
          message: error instanceof Error && error.message !== '' ? error.message : String(error),
        };
      }
    }
    return {
      source: {
        name,
        bytes: new Uint8Array(0),
        sizeBytes: handle.sizeBytes,
        read: (offset, maxBytes) => deps.picker.readAttachmentRange(fileId, offset, maxBytes),
      },
    };
  }

  /** Read a whole picked file, one bounded native read at a time. */
  async function readWhole(fileId: string, sizeBytes: number | null): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      if (sizeBytes !== null && total >= sizeBytes) break;
      const remaining = MAX_SFTP_UPLOAD_BYTES - total;
      if (remaining <= 0) {
        throw new Error(`This file is larger than the ${MAX_SFTP_UPLOAD_BYTES}-byte upload limit.`);
      }
      const chunk = await deps.picker.readAttachmentRange(
        fileId,
        total,
        Math.min(MAX_SFTP_CHUNK_BYTES, remaining),
      );
      if (chunk.byteLength === 0) break;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    if (sizeBytes !== null && total !== sizeBytes) {
      throw new Error('The selected file changed while it was being read. Pick it again.');
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  return { pickFiles, readLocal, stage };
}

function nameOf(source: { name?: string | null }): string {
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  return name === '' ? 'Attachment' : name;
}

/**
 * Apply core's retention policy to one scope directory (7-day TTL, newest 20
 * kept, nothing touched in the last 24 hours removed).
 *
 * Everything here is best-effort on purpose. The policy already refuses to
 * touch a fresh upload, so the only files this can remove are older than a
 * day — and a listing race, a refused delete, or an offline host must never
 * turn a finished upload into a failure the user sees.
 */
async function pruneStaging(
  workspace: ReturnType<typeof createFileWorkspaceService>,
  directory: string,
  nowMillis: number,
  keep: ReadonlySet<string>,
): Promise<void> {
  try {
    const plan = await workspace.planAttachmentRetention(directory, nowMillis);
    for (const path of plan.pathsToDelete) {
      // The batch that just landed is never a candidate, whatever the host
      // reported for its mtime: a clock skew or a coarse timestamp resolution
      // must not delete the file the user is about to send.
      if (keep.has(path)) continue;
      await workspace.deleteFile(path).catch(() => undefined);
    }
  } catch {
    // The directory stays as it was; the next upload tries again.
  }
}

/** The `fileId` inside a `saf:` handle, or null when this is not one. */
function fileIdOf(path: string): string | null {
  if (typeof path !== 'string' || !path.startsWith(SAF_HANDLE_PREFIX)) return null;
  const fileId = path.slice(SAF_HANDLE_PREFIX.length);
  return fileId === '' ? null : fileId;
}

function stagingDirectory(home: string): string | null {
  const base = home.replace(/\/+$/, '');
  if (base === '') return null;
  return `${base}/${STAGING_SEGMENTS.join('/')}`;
}

/** Absolute remote path → the tilde form the draft carries. */
function tildePath(path: string, home: string): string {
  const base = home.replace(/\/+$/, '');
  if (base !== '' && (path === base || path.startsWith(`${base}/`))) {
    return `~${path.slice(base.length)}`;
  }
  return path;
}

/** `yyyyMMdd-HHmmss`, the shape `composeAttachmentFilename` validates. */
function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function describeFailures(
  problems: readonly { sourceName: string; message: string }[],
  total: number,
): string {
  if (problems.length === 0) {
    return COMPOSER_STRINGS.attachmentFailed('the host did not confirm every file');
  }
  const first = problems[0];
  const detail = problems.length === 1
    ? first.message
    : `${problems.length} of ${total} attachments could not be uploaded. ${first.sourceName}: ${first.message}`;
  return COMPOSER_STRINGS.attachmentFailed(detail.replace(/\.+$/, ''));
}

function failure(total: number, message: string): StageAttachmentsResult {
  return { ok: false, paths: [], failedCount: total, error: COMPOSER_STRINGS.attachmentFailed(message) };
}
