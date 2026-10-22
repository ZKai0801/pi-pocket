import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SFTP_TRANSFER_BYTES,
  createPiTransport,
  decodeBase64Utf8,
  type PiSftpReader,
} from '../../src/pi/piTransport';

/** A head-anchored, offset-aware SFTP read over an in-memory file, like the Android plugin's. */
function sftpOver(content: string) {
  const bytes = new TextEncoder().encode(content);
  const calls: Array<{ path: string; maxBytes: number; offset?: number }> = [];
  const reader: PiSftpReader = {
    sftpRead: async (options) => {
      calls.push(options);
      const start = Math.floor(options.offset ?? 0);
      const slice = bytes.subarray(start, start + options.maxBytes);
      return { dataBase64: Buffer.from(slice).toString('base64') };
    },
  };
  return { reader, calls };
}

describe('createPiTransport', () => {
  it('forwards exec verbatim', async () => {
    const exec = { exec: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })) };
    const t = createPiTransport(exec, { sftpRead: vi.fn() });
    expect(await t.exec('ls', 15000)).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(exec.exec).toHaveBeenCalledWith('ls', { timeoutMs: 15000 });
  });

  it('decodes an sftpRead base64 payload as UTF-8 text', async () => {
    const { reader, calls } = sftpOver('{"a":1}\n');
    const t = createPiTransport({ exec: vi.fn() }, reader);
    expect(await t.sftpRead('/x.jsonl', 262144)).toBe('{"a":1}\n');
    expect(calls).toEqual([{ path: '/x.jsonl', maxBytes: 262144, offset: 0 }]);
  });

  it('pages a file larger than one transfer, walking the offset to EOF', async () => {
    const content = Array.from({ length: 40 }, (_, index) => `{"i":${index}}`).join('\n');
    const { reader, calls } = sftpOver(content);
    const t = createPiTransport({ exec: vi.fn() }, reader);
    expect(await t.sftpRead('/x.jsonl', 1024 * 1024, 64)).toBe(content);
    // Every transfer but the last is exactly the chunk; the offsets continue it.
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]).toEqual({ path: '/x.jsonl', maxBytes: 64, offset: 0 });
    expect(calls[1]?.offset).toBe(64);
    expect(calls.at(-1)?.offset).toBe(Math.floor(content.length / 64) * 64);
    for (const call of calls) expect(call.maxBytes).toBeLessThanOrEqual(64);
  });

  it('clamps the transfer to the native plugin bound', async () => {
    const { reader, calls } = sftpOver('tiny');
    const t = createPiTransport({ exec: vi.fn() }, reader);
    expect(await t.sftpRead('/x.jsonl', 4 * 1024 * 1024, 4 * 1024 * 1024)).toBe('tiny');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxBytes).toBe(MAX_SFTP_TRANSFER_BYTES);
  });

  it('stops at maxBytes even when the file is longer', async () => {
    const { reader, calls } = sftpOver('abcdefghij');
    const t = createPiTransport({ exec: vi.fn() }, reader);
    expect(await t.sftpRead('/x.jsonl', 6, 4)).toBe('abcdef');
    expect(calls.map((call) => call.offset)).toEqual([0, 4]);
    expect(calls[1]?.maxBytes).toBe(2);
  });

  it('decodes a multi-byte character split across the transfer boundary', async () => {
    // 4-byte transfers put the boundary inside 中's three bytes: decoding each
    // transfer on its own would corrupt both halves of the character.
    const { reader, calls } = sftpOver('xxx中y');
    const t = createPiTransport({ exec: vi.fn() }, reader);
    expect(await t.sftpRead('/x.jsonl', 1024, 4)).toBe('xxx中y');
    expect(calls.length).toBeGreaterThan(1);
  });

  it('ends the read on an empty payload', async () => {
    const sftp = { sftpRead: vi.fn(async () => ({ dataBase64: '' })) };
    const t = createPiTransport({ exec: vi.fn() }, sftp);
    expect(await t.sftpRead('/x.jsonl', 1024, 256)).toBe('');
    expect(sftp.sftpRead).toHaveBeenCalledTimes(1);
  });

  it('decodes multi-byte UTF-8 across the base64 boundary', () => {
    expect(decodeBase64Utf8(Buffer.from('中文 🎉').toString('base64'))).toBe('中文 🎉');
  });
});
