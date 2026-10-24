import { describe, expect, it, vi } from 'vitest';
import type { SshCapabilityPlugin, SshSftpEntry } from '../../src/native/sshCapability';
import type { AttachmentSource as CoreAttachmentSource } from '@pocketshell/core';
import {
  createAndroidAttachmentPort,
  SAF_HANDLE_PREFIX,
  type AttachmentPicker,
} from '../../src/platform/android/attachmentPort';

const HOME = '/home/alex';
/** Mirrors `platformInput`'s own read ceiling: one native read is 48 KiB. */
const NATIVE_READ_BYTES = 48 * 1024;

interface MockFile {
  bytes: Uint8Array;
  modifiedEpochMs: number;
}

function parent(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, Math.min(at + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

/** An in-memory SFTP host: enough of the plugin for the stager to run whole. */
function createMockSftp() {
  const files = new Map<string, MockFile>();
  const directories = new Set(['/', HOME, `${HOME}/.pocketshell`]);
  const list = vi.fn(async (options: { requestId: string; path: string }) => {
    if (!directories.has(options.path)) throw new Error(`No such directory: ${options.path}`);
    const entries: Array<SshSftpEntry & { type?: string }> = [];
    for (const directory of directories) {
      if (directory !== options.path && parent(directory) === options.path) {
        entries.push({ path: directory, name: basename(directory), type: 'directory', isDirectory: true, sizeBytes: 0, modifiedEpochMs: 1 });
      }
    }
    for (const [path, file] of files) {
      if (parent(path) !== options.path) continue;
      entries.push({
        path,
        name: basename(path),
        type: 'file',
        isDirectory: false,
        sizeBytes: file.bytes.byteLength,
        modifiedEpochMs: file.modifiedEpochMs,
      });
    }
    return { requestId: options.requestId, entries };
  });
  const mkdir = vi.fn(async (options: { requestId: string; path: string }) => {
    directories.add(options.path);
    return { requestId: options.requestId };
  });
  const write = vi.fn(async (options: { requestId: string; path: string; dataBase64: string; createOnly?: boolean }) => {
    if (options.createOnly && files.has(options.path)) throw new Error(`Already exists: ${options.path}`);
    const content = base64ToBytes(options.dataBase64);
    files.set(options.path, { bytes: content, modifiedEpochMs: 2_000 });
    return { requestId: options.requestId, bytesWritten: content.byteLength };
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
    if (options.offset + content.byteLength > options.totalBytes) throw new Error('Chunk runs past the declared size.');
    const merged = existing ? concat(existing.bytes, content) : content;
    files.set(options.path, { bytes: merged, modifiedEpochMs: 2_000 });
    return {
      requestId: options.requestId,
      offset: options.offset,
      bytesWritten: content.byteLength,
      size: merged.byteLength,
    };
  });
  const read = vi.fn(async (options: { requestId: string; path: string; maxBytes: number }) => {
    const file = files.get(options.path);
    if (!file) throw new Error(`No such file: ${options.path}`);
    return { requestId: options.requestId, dataBase64: bytesToBase64(file.bytes.subarray(0, options.maxBytes)) };
  });
  const rename = vi.fn(async (options: { requestId: string; path: string; destination: string }) => {
    const file = files.get(options.path);
    if (file) {
      files.delete(options.path);
      files.set(options.destination, file);
    }
    return { requestId: options.requestId };
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
    sftpWriteIfUnchanged: vi.fn(),
    sftpMkdir: mkdir,
    sftpRename: rename,
    sftpDelete: remove,
  } as unknown as SshCapabilityPlugin;
  return { capability, files, directories, calls: { list, mkdir, write, writeChunk, read, rename, remove } };
}

interface PickerSeed {
  fileId: string;
  name: string;
  bytes: Uint8Array;
  sizeBytes?: number | null;
}

function createMockPicker(seed: PickerSeed[], options: { cancelled?: boolean } = {}) {
  const contents = new Map(seed.map((item) => [item.fileId, item.bytes]));
  const release = vi.fn(async () => undefined);
  const readAttachmentRange = vi.fn(async (fileId: string, offset: number, maxBytes: number) => {
    const bytes = contents.get(fileId);
    if (bytes === undefined) throw new Error(`No such picked file: ${fileId}`);
    // One native read is bounded by the picker's own chunk ceiling.
    return bytes.subarray(offset, Math.min(offset + Math.min(maxBytes, NATIVE_READ_BYTES), bytes.byteLength));
  });
  const pickAttachmentHandles = vi.fn(async () => ({
    cancelled: options.cancelled === true,
    handles: options.cancelled === true
      ? []
      : seed.map((item) => ({
          name: item.name,
          fileId: item.fileId,
          sizeBytes: item.sizeBytes === undefined ? item.bytes.byteLength : item.sizeBytes,
          mimeType: 'image/png',
        })),
    failures: [],
    release,
  }));
  const picker: AttachmentPicker = { pickAttachmentHandles, readAttachmentRange };
  return { picker, calls: { pickAttachmentHandles, readAttachmentRange, release } };
}

function portFor(
  mock: ReturnType<typeof createMockSftp>,
  picker: ReturnType<typeof createMockPicker>,
  overrides: Partial<Parameters<typeof createAndroidAttachmentPort>[0]> = {},
) {
  return createAndroidAttachmentPort({
    picker: picker.picker,
    capability: mock.capability,
    connectionRef: () => ({ connectionId: 'conn-1', generationId: 'gen-1' }),
    home: async () => HOME,
    now: () => new Date(2026, 7, 24, 10, 15, 0),
    ...overrides,
  });
}

function pattern(size: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at += 1) bytes[at] = (at * seed + 11) % 251;
  return bytes;
}

describe('android attachment port', () => {
  it('picks files as bounded saf handles instead of byte buffers', async () => {
    const mock = createMockSftp();
    const picker = createMockPicker([{ fileId: 'f-1', name: 'shot.png', bytes: pattern(2048) }]);
    const port = portFor(mock, picker);

    const paths = await port.pickFiles({ title: 'Attach to prompt', multiple: true });

    expect(paths).toEqual([`${SAF_HANDLE_PREFIX}f-1`]);
    expect(picker.calls.pickAttachmentHandles).toHaveBeenCalledWith({ multiple: true });
    // Nothing was read at pick time: the bytes still live with SAF.
    expect(picker.calls.readAttachmentRange).not.toHaveBeenCalled();
  });

  it('answers an empty list when the picker is cancelled', async () => {
    const mock = createMockSftp();
    const picker = createMockPicker([{ fileId: 'f-1', name: 'shot.png', bytes: pattern(8) }], { cancelled: true });
    const port = portFor(mock, picker);

    await expect(port.pickFiles()).resolves.toEqual([]);
  });

  it('honours a single-select pick', async () => {
    const mock = createMockSftp();
    const picker = createMockPicker([{ fileId: 'f-1', name: 'shot.png', bytes: pattern(8) }]);
    const port = portFor(mock, picker);

    await port.pickFiles({ multiple: false });

    expect(picker.calls.pickAttachmentHandles).toHaveBeenCalledWith({ multiple: false });
  });

  it('reads a picked file back whole, in native-sized ranges', async () => {
    const mock = createMockSftp();
    const bytes = pattern(120_000);
    const picker = createMockPicker([{ fileId: 'f-1', name: 'big.bin', bytes }]);
    const port = portFor(mock, picker);
    const [path] = await port.pickFiles();

    const read = await port.readLocal(path);

    expect(read.byteLength).toBe(bytes.byteLength);
    expect(Array.from(read.subarray(0, 32))).toEqual(Array.from(bytes.subarray(0, 32)));
    expect(Array.from(read.subarray(-32))).toEqual(Array.from(bytes.subarray(-32)));
    expect(picker.calls.readAttachmentRange.mock.calls.length).toBeGreaterThan(1);
  });

  it('refuses to read a path this phone did not pick', async () => {
    const mock = createMockSftp();
    const picker = createMockPicker([]);
    const port = portFor(mock, picker);

    await expect(port.readLocal('/sdcard/Download/shot.png')).rejects.toThrow(/system picker/);
  });

  it('stages a picked file by streaming it into the per-session folder', async () => {
    const mock = createMockSftp();
    const bytes = pattern(700_000);
    const picker = createMockPicker([{ fileId: 'f-1', name: 'shot.png', bytes }]);
    const port = portFor(mock, picker);
    const [path] = await port.pickFiles();

    const result = await port.stage({
      connectionId: 'conn-1',
      scopeKey: 'dtc-site/main',
      sources: [{ kind: 'file', path }],
    });

    expect(result.ok).toBe(true);
    expect(result.failedCount).toBe(0);
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toBe('~/.pocketshell/attachments/dtc-site-main/20260824-101500-01-shot.png');
    const staged = mock.files.get(`${HOME}/.pocketshell/attachments/dtc-site-main/20260824-101500-01-shot.png`);
    expect(staged?.bytes.byteLength).toBe(bytes.byteLength);
    expect(Array.from(staged!.bytes.subarray(0, 16))).toEqual(Array.from(bytes.subarray(0, 16)));
    // Offsets advance contiguously, so a failure mid-file leaves a file whose
    // length is the last acknowledged offset rather than a torn chunk.
    const writes = mock.calls.writeChunk.mock.calls.map(([options]) => ({
      offset: options.offset,
      bytes: base64ToBytes(options.dataBase64).byteLength,
    }));
    expect(writes[0].offset).toBe(0);
    expect(writes.length).toBeGreaterThan(1);
    // The picker hands over at most 48 KiB per native read, so a chunk write is
    // never larger than the 256 KiB the writer allows.
    expect(Math.max(...writes.map((write) => write.bytes))).toBeLessThanOrEqual(256 * 1024);
    for (let index = 1; index < writes.length; index += 1) {
      expect(writes[index].offset).toBe(writes[index - 1].offset + writes[index - 1].bytes);
    }
  });

  it('stages a 5 MB photo, which the old 512 KiB ceiling refused outright', async () => {
    const mock = createMockSftp();
    const bytes = pattern(5 * 1024 * 1024);
    const picker = createMockPicker([{ fileId: 'f-1', name: 'IMG_0042.jpg', bytes }]);
    const port = portFor(mock, picker);
    const [path] = await port.pickFiles();

    const result = await port.stage({ connectionId: 'conn-1', scopeKey: 'main', sources: [{ kind: 'file', path }] });

    expect(result.ok).toBe(true);
    const staged = mock.files.get(`${HOME}/.pocketshell/attachments/main/20260824-101500-01-IMG_0042.jpg`);
    expect(staged?.bytes.byteLength).toBe(bytes.byteLength);
    expect(Array.from(staged!.bytes.subarray(-8))).toEqual(Array.from(bytes.subarray(-8)));
  });

  it('prunes expired attachments in the same scope, and never the ones just uploaded', async () => {
    const mock = createMockSftp();
    const scope = `${HOME}/.pocketshell/attachments/main`;
    mock.directories.add(scope);
    // Eight days old: past core's 7-day TTL, and outside the 24 h protection.
    mock.files.set(`${scope}/20260816-101500-01-expired.png`, {
      bytes: new Uint8Array(4),
      modifiedEpochMs: new Date(2026, 7, 16, 10, 15, 0).getTime(),
    });
    // Half a day old: inside the 24 h protection window, so it must survive.
    mock.files.set(`${scope}/20260824-010000-01-recent.png`, {
      bytes: new Uint8Array(4),
      modifiedEpochMs: new Date(2026, 7, 24, 1, 0, 0).getTime(),
    });

    const picker = createMockPicker([{ fileId: 'f-1', name: 'new.png', bytes: pattern(64) }]);
    const port = portFor(mock, picker);
    const [path] = await port.pickFiles();
    const result = await port.stage({ connectionId: 'conn-1', scopeKey: 'main', sources: [{ kind: 'file', path }] });

    expect(result.ok).toBe(true);
    expect(mock.files.has(`${scope}/20260816-101500-01-expired.png`)).toBe(false);
    expect(mock.files.has(`${scope}/20260824-010000-01-recent.png`)).toBe(true);
    // The batch that just landed is protected by identity, not by its mtime.
    expect(mock.files.has(`${scope}/20260824-101500-01-new.png`)).toBe(true);
  });

  it('stages a clipboard-pasted byte source without touching the picker', async () => {
    const mock = createMockSftp();
    const picker = createMockPicker([]);
    const port = portFor(mock, picker);
    const bytes = pattern(64);

    const result = await port.stage({
      connectionId: 'conn-1',
      scopeKey: 'main',
      sources: [{ kind: 'bytes', data: bytes, name: 'paste.png', mimeType: 'image/png' }],
    });

    expect(result).toMatchObject({ ok: true, failedCount: 0 });
    expect(result.paths[0]).toBe('~/.pocketshell/attachments/main/20260824-101500-01-paste.png');
    expect(picker.calls.readAttachmentRange).not.toHaveBeenCalled();
  });

  it('isolates one unreadable source instead of failing the batch', async () => {
    const mock = createMockSftp();
    const bytes = pattern(4096);
    const picker = createMockPicker([{ fileId: 'f-1', name: 'good.png', bytes }]);
    const port = portFor(mock, picker);
    const [good] = await port.pickFiles();

    const result = await port.stage({
      connectionId: 'conn-1',
      scopeKey: 'main',
      sources: [{ kind: 'file', path: good }, { kind: 'file', path: `${SAF_HANDLE_PREFIX}gone` }],
    });

    expect(result.ok).toBe(false);
    expect(result.failedCount).toBe(1);
    expect(result.paths).toHaveLength(1);
    expect(result.error).toContain('Attachment upload failed');
  });

  it('refuses a file path that is not a picker handle', async () => {
    const mock = createMockSftp();
    const port = portFor(mock, createMockPicker([]));

    const result = await port.stage({
      connectionId: 'conn-1',
      scopeKey: 'main',
      sources: [{ kind: 'file', path: '/sdcard/Download/shot.png' }],
    });

    expect(result.ok).toBe(false);
    expect(result.failedCount).toBe(1);
    expect(mock.calls.writeChunk).not.toHaveBeenCalled();
  });

  it('reports a missing connection rather than staging anywhere', async () => {
    const mock = createMockSftp();
    const port = portFor(mock, createMockPicker([]), { connectionRef: () => null });

    const result = await port.stage({
      connectionId: 'conn-1',
      scopeKey: 'main',
      sources: [{ kind: 'bytes', data: pattern(8), name: 'a.png' }],
    });

    expect(result.ok).toBe(false);
    expect(result.failedCount).toBe(1);
    expect(result.paths).toEqual([]);
    expect(mock.calls.mkdir).not.toHaveBeenCalled();
  });

  it('reports a host whose home could not be read', async () => {
    const mock = createMockSftp();
    const port = portFor(mock, createMockPicker([]), { home: async () => null });

    const result = await port.stage({
      connectionId: 'conn-1',
      scopeKey: 'main',
      sources: [{ kind: 'bytes', data: pattern(8), name: 'a.png' }],
    });

    expect(result.ok).toBe(false);
    expect(result.paths).toEqual([]);
    expect(mock.calls.mkdir).not.toHaveBeenCalled();
  });

  it('answers success with no paths for an empty batch', async () => {
    const mock = createMockSftp();
    const port = portFor(mock, createMockPicker([]));

    await expect(port.stage({ connectionId: 'conn-1', scopeKey: 'main', sources: [] }))
      .resolves.toEqual({ ok: true, paths: [], failedCount: 0 });
  });

  it('releases the picked grant once the batch is staged', async () => {
    const mock = createMockSftp();
    const picker = createMockPicker([{ fileId: 'f-1', name: 'shot.png', bytes: pattern(1024) }]);
    const port = portFor(mock, picker);
    const [path] = await port.pickFiles();

    await port.stage({ connectionId: 'conn-1', scopeKey: 'main', sources: [{ kind: 'file', path }] });

    expect(picker.calls.release).toHaveBeenCalledTimes(1);
    // The handle is spent: staging it again is a re-pick, not a silent retry.
    const again = await port.stage({ connectionId: 'conn-1', scopeKey: 'main', sources: [{ kind: 'file', path }] });
    expect(again.ok).toBe(false);
  });

  it('stops mid-file when the generation is replaced, and keeps what landed', async () => {
    const mock = createMockSftp();
    const bytes = pattern(900_000);
    const picker = createMockPicker([{ fileId: 'f-1', name: 'shot.png', bytes }]);
    let generation = 0;
    const port = portFor(mock, picker, {
      connectionRef: () => ({ connectionId: 'conn-1', generationId: `gen-${generation}` }),
    });
    const [path] = await port.pickFiles();
    const stage = port.stage({ connectionId: 'conn-1', scopeKey: 'main', sources: [{ kind: 'file', path }] });
    generation = 1;

    const result = await stage;

    expect(result.ok).toBe(false);
    // The stager stops on the first chunk after the swap; nothing is claimed.
    expect(result.paths).toEqual([]);
    expect(result.error).toContain('Attachment upload failed');
  });

  it('evicts the oldest pick once the handle table is full', async () => {
    const mock = createMockSftp();
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const picker: AttachmentPicker = {
      pickAttachmentHandles: async () => {
        const release = vi.fn(async () => undefined);
        releases.push(release);
        return {
          cancelled: false,
          handles: [{ name: 'shot.png', fileId: `f-${releases.length}`, sizeBytes: 8, mimeType: null }],
          failures: [],
          release,
        };
      },
      readAttachmentRange: async () => new Uint8Array(8),
    };
    const port = createAndroidAttachmentPort({
      picker,
      capability: mock.capability,
      connectionRef: () => ({ connectionId: 'conn-1', generationId: 'gen-1' }),
      home: async () => HOME,
    });

    for (let index = 0; index < 33; index += 1) await port.pickFiles();

    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(releases[releases.length - 1]).not.toHaveBeenCalled();
  });
});
