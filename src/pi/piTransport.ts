import type { PiTransport } from './piRepository';

export interface PiExecTarget {
  exec(
    command: string,
    options: { timeoutMs: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}

export interface PiSftpReader {
  sftpRead(options: { path: string; maxBytes: number; offset?: number }): Promise<{ dataBase64: string }>;
}

/**
 * One bounded SFTP transfer, mirroring the Android plugin's
 * `MAX_SFTP_TRANSFER_BYTES` (SshCapabilityPlugin.java). The plugin silently
 * clamps a larger `maxBytes`, which would come back short and read as EOF, so
 * the clamp is applied here before requesting.
 */
export const MAX_SFTP_TRANSFER_BYTES = 512 * 1024;

export function decodeBase64(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function decodeBase64Utf8(dataBase64: string): string {
  return new TextDecoder('utf-8').decode(decodeBase64(dataBase64));
}

export function createPiTransport(exec: PiExecTarget, sftp: PiSftpReader): PiTransport {
  return {
    exec: (command: string, timeoutMs: number) => exec.exec(command, { timeoutMs }),
    /**
     * Read a remote text file from its head to EOF — or to `maxBytes`,
     * whichever comes first — in bounded transfers. Every transfer but the
     * last is exactly `chunkBytes`; a short transfer is the file's end.
     *
     * One streaming decoder spans all transfers: a multi-byte UTF-8 character
     * can straddle a transfer boundary, and decoding each transfer on its own
     * would corrupt both halves of it.
     */
    sftpRead: async (path: string, maxBytes: number, chunkBytes?: number) => {
      // Without an explicit chunk the transfer is the plugin's own bound:
      // one read, which is all a small file ever needed.
      const chunk = Math.max(1, Math.min(chunkBytes ?? MAX_SFTP_TRANSFER_BYTES, MAX_SFTP_TRANSFER_BYTES));
      const decoder = new TextDecoder('utf-8');
      let text = '';
      let offset = 0;
      while (offset < maxBytes) {
        const length = Math.min(chunk, maxBytes - offset);
        const { dataBase64 } = await sftp.sftpRead({ path, maxBytes: length, offset });
        if (!dataBase64) break;
        const bytes = decodeBase64(dataBase64);
        if (bytes.length === 0) break;
        text += decoder.decode(bytes, { stream: true });
        offset += bytes.length;
        if (bytes.length < length) break;
      }
      return text + decoder.decode();
    },
  };
}
