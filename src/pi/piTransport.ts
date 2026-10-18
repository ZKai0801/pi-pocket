import type { PiTransport } from './piRepository';

export interface PiExecTarget {
  exec(
    command: string,
    options: { timeoutMs: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}

export interface PiSftpReader {
  sftpRead(options: { path: string; maxBytes: number }): Promise<{ dataBase64: string }>;
}

export function decodeBase64Utf8(dataBase64: string): string {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export function createPiTransport(exec: PiExecTarget, sftp: PiSftpReader): PiTransport {
  return {
    exec: (command: string, timeoutMs: number) => exec.exec(command, { timeoutMs }),
    sftpRead: async (path: string, maxBytes: number) => {
      const { dataBase64 } = await sftp.sftpRead({ path, maxBytes });
      return decodeBase64Utf8(dataBase64);
    },
  };
}
