import type {
  SftpWriteChunkOptions,
  SftpWriteChunkResult,
} from '../native/sshCapability';
import type { SshConnectionRef } from '../native/sshCapability';

/** Mirrors `SshCapabilityPlugin.MAX_SFTP_CHUNK_BYTES`: one bridge call's worth. */
export const MAX_SFTP_CHUNK_BYTES = 256 * 1024;
/** Mirrors `SshCapabilityPlugin.MAX_SFTP_STREAM_BYTES`. */
export const MAX_SFTP_STREAM_BYTES = 64 * 1024 * 1024;

export type SftpChunkWriteErrorCode =
  | 'invalid-size'
  | 'stalled'
  | 'cancelled'
  | 'invalid-response';

export class SftpChunkWriteError extends Error {
  constructor(readonly code: SftpChunkWriteErrorCode, message: string) {
    super(message);
    this.name = 'SftpChunkWriteError';
  }
}

/**
 * The one native call the writer needs. Kept as a narrow seam so the stateless
 * chunked append can be swapped for a sessioned handle implementation later
 * without any caller changing.
 */
export interface SftpChunkSink {
  sftpWriteChunk(options: SftpWriteChunkOptions): Promise<SftpWriteChunkResult>;
}

export interface ChunkWriteRequest {
  connection: SshConnectionRef;
  rootPath: string;
  path: string;
  /** Declared total size; a chunk may never run past it. */
  sizeBytes: number;
  /** Pulls at most `maxBytes` from `offset`. Fewer bytes is legal; zero is not. */
  read: (offset: number, maxBytes: number) => Promise<Uint8Array>;
  /** Fires after an acknowledged write, with the bytes landed so far. */
  onProgress?: (bytesWritten: number) => void;
  isCancelled?: () => boolean;
  /** Test seam and operation correlation hook. */
  nextRequestId?: () => string;
}

export interface ChunkWriteResult {
  path: string;
  /** Bytes actually acknowledged by the host; less than `sizeBytes` when cancelled. */
  bytesWritten: number;
}

/**
 * Push a file to the host as a sequence of bounded, offset-addressed writes.
 *
 * Each chunk is independent: the native side opens, checks that the opened
 * inode's size equals the requested offset, writes and closes. So a chunk that
 * fails or is cancelled leaves the file at the last acknowledged offset rather
 * than a half-written one, and nothing has to be held open between calls.
 * Progress is reported only from acknowledged byte counts — never estimated.
 */
export function createSftpChunkWriter(
  sink: SftpChunkSink,
  options: { chunkBytes?: number; maxBytes?: number } = {},
) {
  const chunkBytes = boundedInteger(options.chunkBytes ?? MAX_SFTP_CHUNK_BYTES, 1, MAX_SFTP_CHUNK_BYTES, 'chunkBytes');
  const maxBytes = boundedInteger(options.maxBytes ?? MAX_SFTP_STREAM_BYTES, 1, MAX_SFTP_STREAM_BYTES, 'maxBytes');
  let sequence = 0;

  async function write(request: ChunkWriteRequest): Promise<ChunkWriteResult> {
    const sizeBytes = request.sizeBytes;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > maxBytes) {
      throw new SftpChunkWriteError('invalid-size', `This transfer supports files between 1 byte and ${maxBytes} bytes.`);
    }

    let offset = 0;
    while (offset < sizeBytes) {
      if (request.isCancelled?.() === true) {
        return { path: request.path, bytesWritten: offset };
      }
      const wanted = Math.min(chunkBytes, sizeBytes - offset);
      const chunk = await request.read(offset, wanted);
      if (!(chunk instanceof Uint8Array)) {
        throw new SftpChunkWriteError('invalid-response', 'The file source returned no bytes.');
      }
      if (chunk.byteLength === 0) {
        throw new SftpChunkWriteError('stalled', 'The file source stopped before the end of the file.');
      }
      if (chunk.byteLength > wanted) {
        throw new SftpChunkWriteError('invalid-response', 'The file source returned more bytes than were asked for.');
      }

      const requestId = request.nextRequestId?.() ?? defaultRequestId(++sequence);
      const payload: SftpWriteChunkOptions = {
        ...request.connection,
        requestId,
        rootPath: request.rootPath,
        path: request.path,
        offset,
        totalBytes: sizeBytes,
        dataBase64: encodeBase64(chunk),
        ...(offset === 0 ? { createOnly: true } : {}),
      };
      const response = await sink.sftpWriteChunk(payload);
      if (!isChunkResult(response)
        || response.requestId !== requestId
        || response.offset !== offset
        || response.bytesWritten !== chunk.byteLength
        || response.size !== offset + chunk.byteLength) {
        throw new SftpChunkWriteError('invalid-response', 'The host did not confirm this part of the file. Try again.');
      }

      offset += chunk.byteLength;
      request.onProgress?.(offset);
    }

    return { path: request.path, bytesWritten: offset };
  }

  return { write };
}

function isChunkResult(value: unknown): value is SftpWriteChunkResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.requestId === 'string'
    && Number.isSafeInteger(candidate.offset)
    && Number.isSafeInteger(candidate.bytesWritten)
    && Number.isSafeInteger(candidate.size);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let at = 0; at < bytes.length; at += step) {
    binary += String.fromCharCode(...bytes.subarray(at, Math.min(at + step, bytes.length)));
  }
  return btoa(binary);
}

function defaultRequestId(sequence: number): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 12);
  return `sftp-chunk-${Date.now().toString(36)}-${sequence.toString(36)}-${random}`;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
