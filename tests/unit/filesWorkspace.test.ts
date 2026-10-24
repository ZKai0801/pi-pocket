import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFileWorkspaceService,
  MAX_SFTP_FILE_BYTES,
  MAX_SFTP_UPLOAD_BYTES,
  SINGLE_SHOT_UPLOAD_BYTES,
  type AttachmentSource,
} from '../../src/session/files';
import type { SshCapabilityPlugin, SshConnectionRef, SshSftpEntry } from '../../src/native/sshCapability';

interface MockFile {
  bytes: Uint8Array;
  modifiedEpochMs: number;
  symlink?: boolean;
}

interface MockSftp {
  capability: SshCapabilityPlugin;
  files: Map<string, MockFile>;
  directories: Set<string>;
  atomicWrite: (options: {
    requestId: string;
    path: string;
    expectedMetadata: { isDirectory: false; sizeBytes: number; modifiedEpochMs: number };
    dataBase64: string;
  }) => Promise<{ requestId: string; status: 'written' | 'conflict'; verdict?: 'missing' | 'changed'; bytesWritten?: number }>;
  calls: {
    list: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    writeChunk: ReturnType<typeof vi.fn>;
    conditionalWrite: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
    rename: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

const connection: SshConnectionRef = { connectionId: 'connection-1', generationId: 'generation-1' };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parent(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function createMockSftp(seed?: {
  directories?: string[];
  files?: Record<string, MockFile>;
  includeDotEntries?: boolean;
}): MockSftp {
  const files = new Map<string, MockFile>(Object.entries(seed?.files ?? {}));
  const directories = new Set(['/home', '/home/alex', '/home/alex/project', ...(seed?.directories ?? [])]);
  const list = vi.fn(async (options: { requestId: string; path: string }) => {
    if (!directories.has(options.path)) throw new Error(`No such directory: ${options.path}`);
    const entries: Array<SshSftpEntry & { type?: string }> = [];
    if (seed?.includeDotEntries) {
      entries.push(
        { path: options.path, name: '.', isDirectory: true, sizeBytes: 0, modifiedEpochMs: 1 },
        { path: parent(options.path), name: '..', isDirectory: true, sizeBytes: 0, modifiedEpochMs: 1 },
      );
    }
    for (const directory of directories) {
      if (directory !== options.path && parent(directory) === options.path) {
        entries.push({
          path: directory,
          name: basename(directory),
          type: 'directory',
          isDirectory: true,
          sizeBytes: 0,
          modifiedEpochMs: 1,
        });
      }
    }
    for (const [path, file] of files) {
      if (parent(path) !== options.path) continue;
      entries.push({
        path,
        name: basename(path),
        type: file.symlink ? 'symlink' : 'file',
        isDirectory: false,
        sizeBytes: file.bytes.byteLength,
        modifiedEpochMs: file.modifiedEpochMs,
      });
    }
    return { requestId: options.requestId, entries };
  });
  const read = vi.fn(async (options: { requestId: string; path: string; maxBytes: number }) => {
    const file = files.get(options.path);
    if (!file) throw new Error(`No such file: ${options.path}`);
    return { requestId: options.requestId, dataBase64: bytesToBase64(file.bytes.subarray(0, options.maxBytes)) };
  });
  const write = vi.fn(async (options: { requestId: string; path: string; dataBase64: string; createOnly?: boolean }) => {
    if (options.createOnly && files.has(options.path)) throw new Error(`Already exists: ${options.path}`);
    const content = base64ToBytes(options.dataBase64);
    files.set(options.path, { bytes: content, modifiedEpochMs: 2_000 });
    return { requestId: options.requestId, bytesWritten: content.byteLength };
  });
  const atomicWrite = async (options: {
    requestId: string;
    path: string;
    expectedMetadata: { isDirectory: false; sizeBytes: number; modifiedEpochMs: number };
    dataBase64: string;
  }) => {
    const file = files.get(options.path);
    if (file == null) return { requestId: options.requestId, status: 'conflict' as const, verdict: 'missing' as const };
    if (file.symlink) throw new Error('Symlinks are rejected by the native SFTP adapter.');
    if (
      options.expectedMetadata.isDirectory
      || options.expectedMetadata.sizeBytes !== file.bytes.byteLength
      || options.expectedMetadata.modifiedEpochMs !== file.modifiedEpochMs
    ) {
      return { requestId: options.requestId, status: 'conflict' as const, verdict: 'changed' as const };
    }
    const content = base64ToBytes(options.dataBase64);
    files.set(options.path, { bytes: content, modifiedEpochMs: 2_000 });
    return { requestId: options.requestId, status: 'written' as const, bytesWritten: content.byteLength };
  };
  const conditionalWrite = vi.fn(atomicWrite);
  const mkdir = vi.fn(async (options: { requestId: string; path: string }) => {
    directories.add(options.path);
    return { requestId: options.requestId };
  });
  const rename = vi.fn(async (options: { requestId: string; path: string; destination: string }) => {
    const file = files.get(options.path);
    if (file) {
      files.delete(options.path);
      files.set(options.destination, file);
    }
    return { requestId: options.requestId };
  });
  const writeChunk = vi.fn(async (options: {
    requestId: string;
    path: string;
    offset: number;
    totalBytes: number;
    dataBase64: string;
    createOnly?: boolean;
  }) => {
    const existing = files.get(options.path);
    if (options.createOnly && existing) throw new Error(`Already exists: ${options.path}`);
    if (options.offset > 0 && !existing) throw new Error(`No such file: ${options.path}`);
    if (existing && existing.bytes.byteLength !== options.offset) {
      throw new Error(`Offset mismatch at ${options.path}: ${existing.bytes.byteLength} vs ${options.offset}`);
    }
    const content = base64ToBytes(options.dataBase64);
    const merged = existing ? concatBytes(existing.bytes, content) : content;
    files.set(options.path, { bytes: merged, modifiedEpochMs: 2_000 });
    return {
      requestId: options.requestId,
      offset: options.offset,
      bytesWritten: content.byteLength,
      size: options.offset + content.byteLength,
    };
  });
  const remove = vi.fn(async (options: { requestId: string; path: string }) => {
    files.delete(options.path);
    return { requestId: options.requestId };
  });
  const capability = {
    addListener: vi.fn(),
    removeAllListeners: vi.fn(),
    sftpList: list,
    sftpRead: read,
    sftpWrite: write,
    sftpWriteChunk: writeChunk,
    sftpWriteIfUnchanged: conditionalWrite,
    sftpMkdir: mkdir,
    sftpRename: rename,
    sftpDelete: remove,
  } as unknown as SshCapabilityPlugin;
  return {
    capability,
    files,
    directories,
    atomicWrite,
    calls: { list, read, write, writeChunk, conditionalWrite, mkdir, rename, remove },
  };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

function serviceFor(mock: MockSftp, options?: {
  rootDirectory?: string;
  initialDirectory?: string;
  isCurrent?: () => boolean;
  nextRequestId?: () => string;
}) {
  let request = 0;
  return createFileWorkspaceService(mock.capability, {
    connection,
    rootDirectory: options?.rootDirectory ?? '/home/alex/project',
    initialDirectory: options?.initialDirectory,
    isCurrent: options?.isCurrent,
    nextRequestId: options?.nextRequestId ?? (() => `test-${++request}`),
  });
}

describe('SFTP file workspace policy and byte-I/O adapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves paths under the configured remote root and rejects traversal and NUL', () => {
    const service = serviceFor(createMockSftp());

    expect(service.resolvePath('notes/../readme.md')).toBe('/home/alex/project/readme.md');
    expect(() => service.resolvePath('../outside.txt')).toThrowError(
      expect.objectContaining({ code: 'outside-root' }),
    );
    expect(() => service.resolvePath('bad\0name')).toThrowError(
      expect.objectContaining({ code: 'invalid-path' }),
    );
  });

  it('lists valid children with shared directory-first ordering and name classification', async () => {
    const mock = createMockSftp({
      directories: ['/home/alex/project/Zed'],
      files: {
        '/home/alex/project/b.txt': { bytes: new TextEncoder().encode('b'), modifiedEpochMs: 10 },
        '/home/alex/project/a.png': { bytes: new Uint8Array([1]), modifiedEpochMs: 10 },
        '/home/alex/project/Readme.MD': { bytes: new TextEncoder().encode('hello'), modifiedEpochMs: 10 },
      },
      includeDotEntries: true,
    });

    const listing = await serviceFor(mock).listDirectory();

    expect(listing.entries.map(({ name }) => name)).toEqual(['Zed', 'a.png', 'b.txt', 'Readme.MD']);
    expect(listing.entries.map(({ classification }) => classification?.kind ?? null)).toEqual([
      null, 'image', 'text', 'markdown',
    ]);
  });

  it('rejects unsafe names returned by native SFTP listing', async () => {
    const mock = createMockSftp();
    mock.calls.list.mockImplementationOnce(async (options) => ({
      requestId: options.requestId,
      entries: [{ path: '/tmp/escape', name: '../escape', isDirectory: false, sizeBytes: 1, modifiedEpochMs: 1 }],
    }));

    await expect(serviceFor(mock).listDirectory()).rejects.toMatchObject({ code: 'invalid-entry' });
  });

  it('rejects duplicate child names instead of selecting an ambiguous remote path', async () => {
    const mock = createMockSftp();
    mock.calls.list.mockImplementationOnce(async (options) => ({
      requestId: options.requestId,
      entries: [
        { path: options.path, name: 'same.txt', isDirectory: false, sizeBytes: 1, modifiedEpochMs: 1 },
        { path: options.path, name: 'same.txt', isDirectory: false, sizeBytes: 2, modifiedEpochMs: 2 },
      ],
    }));

    await expect(serviceFor(mock).listDirectory()).rejects.toMatchObject({ code: 'invalid-entry' });
  });

  it('reads bounded bytes and combines filename and magic classification', async () => {
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const mock = createMockSftp({
      files: { '/home/alex/project/mystery.data': { bytes: pdf, modifiedEpochMs: 10 } },
    });

    const result = await serviceFor(mock).readFile('mystery.data', 64);

    expect([...result.bytes]).toEqual([...pdf]);
    expect(result.classification).toEqual({ kind: 'pdf', mime: 'application/pdf' });
    expect(mock.calls.read).toHaveBeenCalledWith(expect.objectContaining({
      path: '/home/alex/project/mystery.data',
      maxBytes: 64,
      connectionId: connection.connectionId,
      generationId: connection.generationId,
    }));
  });

  it('rejects oversized files before reading and detects a size change during bounded reads', async () => {
    const mock = createMockSftp({
      files: {
        '/home/alex/project/large.dat': { bytes: new Uint8Array(128), modifiedEpochMs: 10 },
        '/home/alex/project/raced.dat': { bytes: new Uint8Array(10), modifiedEpochMs: 10 },
      },
    });
    const service = serviceFor(mock);

    await expect(service.readFile('large.dat', 32)).rejects.toMatchObject({ code: 'file-too-large' });
    expect(mock.calls.read).not.toHaveBeenCalled();

    mock.calls.read.mockImplementationOnce(async (options) => ({
      requestId: options.requestId,
      dataBase64: bytesToBase64(new Uint8Array(9)),
    }));
    await expect(service.readFile('raced.dat', 32)).rejects.toMatchObject({ code: 'file-changed' });
  });

  it('refuses to save when metadata changes immediately before the native conditional write', async () => {
    const mock = createMockSftp({
      files: { '/home/alex/project/readme.md': { bytes: new TextEncoder().encode('before'), modifiedEpochMs: 10 } },
    });
    const service = serviceFor(mock);
    const snapshot = await service.loadTextForEdit('readme.md');
    expect(snapshot.text).toBe('before');

    const checkAndWrite = mock.calls.conditionalWrite.getMockImplementation();
    expect(checkAndWrite).toBeDefined();
    mock.calls.conditionalWrite.mockImplementationOnce(async (options) => {
      // Model a server-side edit after the caller captured metadata but before
      // the native adapter compares it and writes.
      mock.files.set('/home/alex/project/readme.md', {
        bytes: new TextEncoder().encode('different length'),
        modifiedEpochMs: 20,
      });
      return checkAndWrite!(options);
    });
    const result = await service.saveText(snapshot, 'after');

    expect(result).toEqual({ status: 'conflict', path: '/home/alex/project/readme.md', verdict: 'changed' });
    expect(mock.calls.conditionalWrite).toHaveBeenCalledTimes(1);
    expect(mock.calls.write).not.toHaveBeenCalled();
  });

  it('saves UTF-8 edits only through the native conditional write when metadata still matches', async () => {
    const mock = createMockSftp({
      files: { '/home/alex/project/readme.md': { bytes: new TextEncoder().encode('before'), modifiedEpochMs: 10 } },
    });
    const service = serviceFor(mock);
    const snapshot = await service.loadTextForEdit('readme.md');
    const result = await service.saveText(snapshot, 'café 🧪');

    expect(result).toEqual({ status: 'saved', path: '/home/alex/project/readme.md', bytesWritten: new TextEncoder().encode('café 🧪').length });
    expect(mock.files.get(snapshot.path)?.bytes).toEqual(new TextEncoder().encode('café 🧪'));
    expect(mock.calls.conditionalWrite).toHaveBeenCalledWith(expect.objectContaining({
      path: snapshot.path,
      rootPath: '/home/alex/project',
      expectedMetadata: snapshot.metadata,
      dataBase64: bytesToBase64(new TextEncoder().encode('café 🧪')),
    }));
    expect(mock.calls.write).not.toHaveBeenCalled();
  });

  it('fails closed on a symlink entry before reading or writing', async () => {
    const mock = createMockSftp({
      files: { '/home/alex/project/link.txt': { bytes: new TextEncoder().encode('target'), modifiedEpochMs: 10, symlink: true } },
    });
    const service = serviceFor(mock);

    await expect(service.readFile('link.txt')).rejects.toMatchObject({ code: 'symlink-unsupported' });
    await expect(service.writeFile('link.txt', new TextEncoder().encode('replace'), true))
      .rejects.toMatchObject({ code: 'symlink-unsupported' });
    expect(mock.calls.read).not.toHaveBeenCalled();
    expect(mock.calls.write).not.toHaveBeenCalled();
  });

  it('fails closed when the native listing omits a regular-file type', async () => {
    const mock = createMockSftp({
      files: { '/home/alex/project/untyped.txt': { bytes: new TextEncoder().encode('text'), modifiedEpochMs: 10 } },
    });
    mock.calls.list.mockImplementation(async (options) => ({
      requestId: options.requestId,
      entries: [{ path: options.path, name: 'untyped.txt', isDirectory: false, sizeBytes: 4, modifiedEpochMs: 10 }],
    }));

    const listing = await serviceFor(mock).listDirectory();

    expect(listing.entries[0]?.type).toBe('other');
    await expect(serviceFor(mock).readFile('untyped.txt')).rejects.toMatchObject({ code: 'not-file' });
    expect(mock.calls.read).not.toHaveBeenCalled();
  });

  it('does not offer binary magic content to the text editor', async () => {
    const mock = createMockSftp({
      files: { '/home/alex/project/unknown.data': { bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]), modifiedEpochMs: 10 } },
    });

    await expect(serviceFor(mock).loadTextForEdit('unknown.data')).rejects.toMatchObject({ code: 'not-editable' });
  });

  it('uploads bytes through a resolved path and prevents implicit overwrite', async () => {
    const mock = createMockSftp();
    const service = serviceFor(mock);
    const content = new TextEncoder().encode('upload bytes');
    const uploaded = await service.writeFile('new.txt', content);

    expect(uploaded).toEqual({ path: '/home/alex/project/new.txt', bytesWritten: content.length });
    await expect(service.writeFile('new.txt', content)).rejects.toMatchObject({ code: 'file-exists' });
    expect(mock.calls.write).toHaveBeenCalledTimes(1);
  });

  it('stages sanitized attachment names, preserves partial success, and returns retention candidates', async () => {
    const mock = createMockSftp({ directories: ['/home/alex/project/uploads'] });
    const service = serviceFor(mock);
    const valid = new TextEncoder().encode('attachment');
    const attachments: AttachmentSource[] = [
      { name: '../plan for review?.md', bytes: valid },
      // Oversize is declared, not allocated: the guard rejects it on size alone.
      { name: 'too-large.bin', bytes: new Uint8Array(0), sizeBytes: MAX_SFTP_UPLOAD_BYTES + 1 },
    ];
    const staged = await service.stageAttachments({
      directory: 'uploads',
      scopeKey: 'Host A/session',
      timestamp: '20260102-030405',
      attachments,
    });

    expect(staged.directory).toBe('/home/alex/project/uploads/host-a-session');
    expect(staged.decision).toMatchObject({ kind: 'partial', failedCount: 1, attachments: [{
      filename: '20260102-030405-01-plan_for_review.md',
      sourceName: '../plan for review?.md',
      sizeBytes: valid.length,
    }] });
    expect(mock.files.has(`${staged.directory}/20260102-030405-02-too-large.bin`)).toBe(false);

    mock.files.set(`${staged.directory}/old.txt`, { bytes: valid, modifiedEpochMs: 1_000 });
    mock.files.set(`${staged.directory}/new.txt`, { bytes: valid, modifiedEpochMs: 9_500 });
    const plan = await service.planAttachmentRetention(staged.directory, 10_000, {
      ttlMillis: 2_000,
      keepNewest: 1,
      protectNewestMillis: 0,
    });
    expect(plan.pathsToDelete).toContain(`${staged.directory}/old.txt`);
    expect(plan.pathsToDelete).not.toContain(`${staged.directory}/new.txt`);
  });

  it('does not return completed uploads as attachments after cancellation', async () => {
    const mock = createMockSftp({ directories: ['/home/alex/project/uploads'] });
    const service = serviceFor(mock);
    let checks = 0;
    const staged = await service.stageAttachments({
      directory: 'uploads',
      scopeKey: 'session-a',
      timestamp: '20260102-030405',
      attachments: [
        { name: 'first.txt', bytes: new TextEncoder().encode('one') },
        { name: 'second.txt', bytes: new TextEncoder().encode('two') },
      ],
      isCancelled: () => ++checks >= 3,
    });

    expect(staged.decision).toEqual({ kind: 'cancelled', attachments: [], completedUploadCount: 1 });
    expect(mock.calls.write).toHaveBeenCalledTimes(1);
  });

  it('leaves the remote tree untouched for an empty attachment batch', async () => {
    const mock = createMockSftp({ directories: ['/home/alex/project/uploads'] });
    const staged = await serviceFor(mock).stageAttachments({
      directory: 'uploads',
      scopeKey: 'empty-session',
      timestamp: '20260102-030405',
      attachments: [],
    });

    expect(staged.decision).toEqual({ kind: 'empty', attachments: [] });
    expect(mock.calls.list).not.toHaveBeenCalled();
    expect(mock.calls.mkdir).not.toHaveBeenCalled();
  });

  it('streams a file above the single-shot ceiling instead of refusing it', async () => {
    const mock = createMockSftp();
    const service = serviceFor(mock);
    const payload = new Uint8Array(SINGLE_SHOT_UPLOAD_BYTES + 1024).fill(7);

    const uploaded = await service.writeFile('large.bin', payload);

    expect(uploaded.bytesWritten).toBe(payload.byteLength);
    // Offset-addressed chunks, never one oversized single-shot write.
    expect(mock.calls.write).not.toHaveBeenCalled();
    expect(mock.calls.writeChunk).toHaveBeenCalled();
    expect(mock.files.get('/home/alex/project/large.bin')?.bytes.byteLength).toBe(payload.byteLength);
  });

  it('rejects an attachment above the upload ceiling before issuing any write', async () => {
    const mock = createMockSftp({ directories: ['/home/alex/project/uploads'] });
    const service = serviceFor(mock);
    const staged = await service.stageAttachments({
      directory: 'uploads',
      scopeKey: 'too-large',
      timestamp: '20260102-030405',
      attachments: [{
        name: 'huge.bin',
        bytes: new Uint8Array(0),
        sizeBytes: MAX_SFTP_UPLOAD_BYTES + 1,
        read: async () => new Uint8Array(0),
      }],
    });

    expect(staged.decision).toMatchObject({ kind: 'failed' });
    expect(staged.failures[0]?.message).toContain('upload limit');
    expect(mock.calls.write).not.toHaveBeenCalled();
    expect(mock.calls.writeChunk).not.toHaveBeenCalled();
  });

  it('streams an attachment from a lazy source without buffering it whole', async () => {
    const mock = createMockSftp({ directories: ['/home/alex/project/uploads'] });
    const service = serviceFor(mock);
    const sizeBytes = 700 * 1024;
    let largestRequest = 0;

    const staged = await service.stageAttachments({
      directory: 'uploads',
      scopeKey: 'lazy',
      timestamp: '20260102-030405',
      attachments: [{
        name: 'photo.png',
        bytes: new Uint8Array(0),
        sizeBytes,
        read: async (offset, maxBytes) => {
          largestRequest = Math.max(largestRequest, maxBytes);
          return new Uint8Array(Math.min(maxBytes, sizeBytes - offset)).fill(3);
        },
      }],
    });

    expect(staged.decision).toMatchObject({ kind: 'complete' });
    expect(staged.decision.kind === 'complete' && staged.decision.attachments[0]?.sizeBytes).toBe(sizeBytes);
    // The reader is never asked for the whole file at once.
    expect(largestRequest).toBeLessThan(sizeBytes);
    expect(mock.calls.write).not.toHaveBeenCalled();
  });

  it('reports upload progress from acknowledged writes, ending at the full batch size', async () => {
    const mock = createMockSftp({ directories: ['/home/alex/project/uploads'] });
    const service = serviceFor(mock);
    const sizeBytes = 700 * 1024;
    const reports: Array<{
      fileIndex: number;
      fileCount: number;
      batchBytesWritten: number;
      batchBytesTotal: number;
      completedFileCount: number;
    }> = [];

    const staged = await service.stageAttachments({
      directory: 'uploads',
      scopeKey: 'progress',
      timestamp: '20260102-030405',
      attachments: [{
        name: 'photo.png',
        bytes: new Uint8Array(0),
        sizeBytes,
        read: async (offset, maxBytes) => new Uint8Array(Math.min(maxBytes, sizeBytes - offset)).fill(3),
      }],
      onProgress: (progress) => {
        reports.push({
          fileIndex: progress.fileIndex,
          fileCount: progress.fileCount,
          batchBytesWritten: progress.batchBytesWritten,
          batchBytesTotal: progress.batchBytesTotal,
          completedFileCount: progress.completedFileCount,
        });
      },
    });

    expect(staged.decision).toMatchObject({ kind: 'complete' });
    // More than one step: a 700 KiB file cannot arrive in a single ack.
    expect(reports.length).toBeGreaterThan(1);
    // Monotonic, never past the batch total.
    const written = reports.map((report) => report.batchBytesWritten);
    expect(written).toEqual([...written].sort((left, right) => left - right));
    expect(written.every((count) => count <= sizeBytes)).toBe(true);
    // The final ack is what closes the bar: nothing is left over.
    expect(reports[reports.length - 1]).toMatchObject({
      fileIndex: 0,
      fileCount: 1,
      batchBytesWritten: sizeBytes,
      batchBytesTotal: sizeBytes,
      completedFileCount: 0,
    });
  });

  it('keeps reporting later files after one of them failed', async () => {
    const mock = createMockSftp({ directories: ['/home/alex/project/uploads'] });
    const service = serviceFor(mock);
    // The first file's write is refused; the batch keeps going on purpose.
    mock.calls.write.mockRejectedValueOnce(new Error('remote write refused'));
    const reports: Array<{ batchBytesWritten: number; completedFileCount: number }> = [];

    const staged = await service.stageAttachments({
      directory: 'uploads',
      scopeKey: 'mixed',
      timestamp: '20260102-030405',
      attachments: [
        { name: 'broken.txt', bytes: new TextEncoder().encode('nope') },
        { name: 'fine.txt', bytes: new TextEncoder().encode('ok') },
      ],
      onProgress: (progress) => {
        reports.push({
          batchBytesWritten: progress.batchBytesWritten,
          completedFileCount: progress.completedFileCount,
        });
      },
    });

    expect(staged.failures).toHaveLength(1);
    expect(staged.decision.attachments).toHaveLength(1);
    // The second file still moved the bar to its own size, and the failed one
    // never counted as completed.
    expect(reports[reports.length - 1]).toEqual({ batchBytesWritten: 2, completedFileCount: 0 });
  });

  it('deletes a staged file, and treats a missing one as already gone', async () => {
    const mock = createMockSftp();
    const service = serviceFor(mock);
    await service.writeFile('old.txt', new TextEncoder().encode('bye'));
    expect(mock.files.has('/home/alex/project/old.txt')).toBe(true);

    await service.deleteFile('old.txt');

    expect(mock.files.has('/home/alex/project/old.txt')).toBe(false);
    expect(mock.calls.remove).toHaveBeenCalledTimes(1);
    // The pruner reads a listing first, so "already gone" is the outcome it
    // wanted — not an error to report up the stack.
    await expect(service.deleteFile('old.txt')).resolves.toBeUndefined();
    expect(mock.calls.remove).toHaveBeenCalledTimes(1);
  });

  it('refuses to delete a directory through the file-only pruner', async () => {
    const mock = createMockSftp({ directories: ['/home/alex/project/uploads'] });
    const service = serviceFor(mock);

    await expect(service.deleteFile('uploads')).rejects.toMatchObject({ code: 'not-file' });
    expect(mock.calls.remove).not.toHaveBeenCalled();
  });

  it('rejects stale generations before requests and after in-flight responses', async () => {
    let current = false;
    const staleMock = createMockSftp();
    const staleService = serviceFor(staleMock, { isCurrent: () => current });
    await expect(staleService.listDirectory()).rejects.toMatchObject({ code: 'stale-generation' });
    expect(staleMock.calls.list).not.toHaveBeenCalled();

    current = true;
    const racingMock = createMockSftp();
    const racingService = serviceFor(racingMock, { isCurrent: () => current });
    racingMock.calls.write.mockImplementationOnce(async (options) => {
      const result = await Promise.resolve({ requestId: options.requestId, bytesWritten: 4 });
      current = false;
      return result;
    });
    await expect(racingService.writeFile('raced.txt', new TextEncoder().encode('late')))
      .rejects.toMatchObject({ code: 'stale-generation' });
    expect(racingMock.calls.write).toHaveBeenCalledTimes(1);
  });

  it('rejects native responses with an unrelated request ID', async () => {
    const mock = createMockSftp();
    mock.calls.list.mockImplementationOnce(async () => ({ requestId: 'wrong-id', entries: [] }));

    await expect(serviceFor(mock).listDirectory()).rejects.toMatchObject({ code: 'invalid-response' });
  });
});
