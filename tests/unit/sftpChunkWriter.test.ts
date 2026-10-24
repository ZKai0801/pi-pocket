import { describe, expect, it } from 'vitest';
import {
  createSftpChunkWriter,
  MAX_SFTP_CHUNK_BYTES,
  MAX_SFTP_STREAM_BYTES,
  SftpChunkWriteError,
  type SftpChunkSink,
} from '../../src/session/sftpChunkWriter';
import type { SftpWriteChunkOptions, SftpWriteChunkResult } from '../../src/native/sshCapability';

interface RecordedCall extends SftpWriteChunkOptions {}

function sinkOf(options: {
  /** Override the response the sink returns for a call. */
  respond?: (call: RecordedCall, index: number) => SftpWriteChunkResult | Promise<SftpWriteChunkResult>;
  /** Mutate the base64-free view before it is recorded, for assertions. */
  onCall?: (call: RecordedCall, index: number) => void;
} = {}) {
  const calls: RecordedCall[] = [];
  const sink: SftpChunkSink = {
    async sftpWriteChunk(call) {
      const index = calls.length;
      options.onCall?.(call, index);
      calls.push(call);
      if (options.respond) return options.respond(call, index);
      return {
        requestId: call.requestId,
        offset: call.offset,
        bytesWritten: decode(call.dataBase64).byteLength,
        size: call.offset + decode(call.dataBase64).byteLength,
      };
    },
  };
  return { sink, calls };
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A source of `sizeBytes` bytes with a recognisable per-byte pattern. */
function sourceOf(sizeBytes: number) {
  return async (offset: number, maxBytes: number): Promise<Uint8Array> => {
    const length = Math.min(maxBytes, sizeBytes - offset);
    const bytes = new Uint8Array(Math.max(0, length));
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (offset + i) % 251;
    return bytes;
  };
}

const CONNECTION = { connectionId: 'c1', generationId: 'g1' };

function requestOf(overrides: Partial<Parameters<ReturnType<typeof createSftpChunkWriter>['write']>[0]> = {}) {
  return {
    connection: CONNECTION,
    rootPath: '/root',
    path: '/root/file.bin',
    sizeBytes: 4,
    read: sourceOf(4),
    ...overrides,
  };
}

describe('sftp chunk writer', () => {
  it('writes a file as ordered chunks ending at the declared size', async () => {
    const { sink, calls } = sinkOf();
    const writer = createSftpChunkWriter(sink, { chunkBytes: 4 });
    const result = await writer.write(requestOf({ sizeBytes: 10, read: sourceOf(10) }));

    expect(result).toEqual({ path: '/root/file.bin', bytesWritten: 10 });
    expect(calls.map((call) => call.offset)).toEqual([0, 4, 8]);
    expect(calls.map((call) => call.totalBytes)).toEqual([10, 10, 10]);
    // The last chunk is the remainder, not a full chunk.
    expect(decode(calls[2]!.dataBase64).byteLength).toBe(2);
  });

  it('sends the exact bytes the source produced for each offset', async () => {
    const { sink, calls } = sinkOf();
    const writer = createSftpChunkWriter(sink, { chunkBytes: 4 });
    await writer.write(requestOf({ sizeBytes: 6, read: sourceOf(6) }));

    const first = decode(calls[0]!.dataBase64);
    expect([...first]).toEqual([0, 1, 2, 3]);
    const second = decode(calls[1]!.dataBase64);
    expect([...second]).toEqual([4, 5]);
  });

  it('reports progress only from acknowledged writes', async () => {
    const progress: number[] = [];
    const { sink } = sinkOf();
    const writer = createSftpChunkWriter(sink, { chunkBytes: 4 });
    await writer.write(requestOf({
      sizeBytes: 8,
      read: sourceOf(8),
      onProgress: (bytesWritten) => progress.push(bytesWritten),
    }));

    expect(progress).toEqual([4, 8]);
  });

  it('marks the first chunk create-only so an existing file is refused', async () => {
    const { sink, calls } = sinkOf();
    const writer = createSftpChunkWriter(sink, { chunkBytes: 4 });
    await writer.write(requestOf({ sizeBytes: 6, read: sourceOf(6) }));

    expect(calls.map((call) => call.createOnly)).toEqual([true, undefined]);
  });

  it('refuses a size above the streaming ceiling', async () => {
    const { sink } = sinkOf();
    const writer = createSftpChunkWriter(sink);
    await expect(
      writer.write(requestOf({ sizeBytes: MAX_SFTP_STREAM_BYTES + 1, read: sourceOf(0) })),
    ).rejects.toBeInstanceOf(SftpChunkWriteError);
  });

  it('refuses a size that is not a positive safe integer', async () => {
    const { sink } = sinkOf();
    const writer = createSftpChunkWriter(sink);
    for (const sizeBytes of [0, -1, 1.5, Number.NaN]) {
      await expect(
        writer.write(requestOf({ sizeBytes, read: sourceOf(0) })),
      ).rejects.toBeInstanceOf(SftpChunkWriteError);
    }
  });

  it('rejects a response whose offset disagrees with the request', async () => {
    const { sink } = sinkOf({
      respond: (call) => ({
        requestId: call.requestId,
        offset: call.offset + 1,
        bytesWritten: 4,
        size: call.offset + 4,
      }),
    });
    const writer = createSftpChunkWriter(sink, { chunkBytes: 4 });
    await expect(
      writer.write(requestOf({ sizeBytes: 4, read: sourceOf(4) })),
    ).rejects.toBeInstanceOf(SftpChunkWriteError);
  });

  it('rejects a response whose byte count disagrees with the chunk sent', async () => {
    const { sink } = sinkOf({
      respond: (call) => ({
        requestId: call.requestId,
        offset: call.offset,
        bytesWritten: 3,
        size: call.offset + 4,
      }),
    });
    const writer = createSftpChunkWriter(sink, { chunkBytes: 4 });
    await expect(
      writer.write(requestOf({ sizeBytes: 4, read: sourceOf(4) })),
    ).rejects.toBeInstanceOf(SftpChunkWriteError);
  });

  it('rejects a response carrying another request id', async () => {
    const { sink } = sinkOf({
      respond: (call) => ({
        requestId: `${call.requestId}-other`,
        offset: call.offset,
        bytesWritten: 4,
        size: call.offset + 4,
      }),
    });
    const writer = createSftpChunkWriter(sink, { chunkBytes: 4 });
    await expect(
      writer.write(requestOf({ sizeBytes: 4, read: sourceOf(4) })),
    ).rejects.toBeInstanceOf(SftpChunkWriteError);
  });

  it('stops before the next chunk when cancelled', async () => {
    let cancelled = false;
    const { sink, calls } = sinkOf({
      onCall: () => {
        cancelled = true;
      },
    });
    const writer = createSftpChunkWriter(sink, { chunkBytes: 4 });
    const result = await writer.write(requestOf({
      sizeBytes: 12,
      read: sourceOf(12),
      isCancelled: () => cancelled,
    }));

    expect(calls).toHaveLength(1);
    expect(result.bytesWritten).toBe(4);
  });

  it('cancels without writing when the signal is already set', async () => {
    const { sink, calls } = sinkOf();
    const writer = createSftpChunkWriter(sink, { chunkBytes: 4 });
    const result = await writer.write(requestOf({
      sizeBytes: 12,
      read: sourceOf(12),
      isCancelled: () => true,
    }));

    expect(calls).toHaveLength(0);
    expect(result.bytesWritten).toBe(0);
  });

  it('refuses a source that stalls before the declared end', async () => {
    const { sink } = sinkOf();
    const writer = createSftpChunkWriter(sink, { chunkBytes: 4 });
    await expect(
      writer.write(requestOf({ sizeBytes: 8, read: async () => new Uint8Array(0) })),
    ).rejects.toBeInstanceOf(SftpChunkWriteError);
  });

  it('refuses a chunk size outside the per-call ceiling', () => {
    const { sink } = sinkOf();
    expect(() => createSftpChunkWriter(sink, { chunkBytes: MAX_SFTP_CHUNK_BYTES + 1 }))
      .toThrow(RangeError);
    expect(() => createSftpChunkWriter(sink, { chunkBytes: 0 })).toThrow(RangeError);
  });
});
