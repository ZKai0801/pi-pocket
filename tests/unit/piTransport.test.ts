import { describe, expect, it, vi } from 'vitest';
import { createPiTransport, decodeBase64Utf8 } from '../../src/pi/piTransport';

describe('createPiTransport', () => {
  it('forwards exec verbatim', async () => {
    const exec = { exec: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })) };
    const t = createPiTransport(exec, { sftpRead: vi.fn() });
    expect(await t.exec('ls', 15000)).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(exec.exec).toHaveBeenCalledWith('ls', { timeoutMs: 15000 });
  });

  it('decodes an sftpRead base64 payload as UTF-8 text', async () => {
    const sftp = { sftpRead: vi.fn(async () => ({ dataBase64: Buffer.from('{"a":1}\n').toString('base64') })) };
    const t = createPiTransport({ exec: vi.fn() }, sftp);
    expect(await t.sftpRead('/x.jsonl', 262144)).toBe('{"a":1}\n');
    expect(sftp.sftpRead).toHaveBeenCalledWith({ path: '/x.jsonl', maxBytes: 262144 });
  });

  it('decodes multi-byte UTF-8 across the base64 boundary', () => {
    expect(decodeBase64Utf8(Buffer.from('中文 🎉').toString('base64'))).toBe('中文 🎉');
  });
});
