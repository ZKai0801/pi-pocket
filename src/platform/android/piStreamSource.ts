import {
  listenToStreamOutput,
  openNativeStream,
  type SshStreamTarget,
} from '../../native/sshCapability';
import type { PiStreamChunk, PiStreamHandle, PiStreamSource } from '../../pi/piStream';
import { decodeBase64 } from '../../pi/piTransport';

/**
 * The Android implementation of the long-lived exec channel: one plugin
 * channel per command, output pushed as `streamOutput` events.
 *
 * The listener is global and installed once — the plugin names the channel on
 * every event — while decoding is per channel: a multi-byte UTF-8 character
 * can straddle two events, so one streaming decoder has to span all of them
 * (the same reason `PiTransport.sftpRead` decodes its chunks as one stream).
 */

interface ChannelSink {
  onChunk: (chunk: PiStreamChunk) => void;
  decoder: TextDecoder;
}

export interface AndroidStreamSourceOptions {
  /** The live connection a channel is opened on; throws when there is none. */
  target: () => SshStreamTarget;
}

export function createAndroidStreamSource(options: AndroidStreamSourceOptions): PiStreamSource {
  const sinks = new Map<string, ChannelSink>();
  let listening: Promise<void> | null = null;

  function ensureListening(): Promise<void> {
    if (listening !== null) return listening;
    listening = listenToStreamOutput((event) => {
      const sink = sinks.get(event.channelId);
      if (!sink) return;
      if (typeof event.dataBase64 === 'string' && event.dataBase64.length > 0) {
        const text = sink.decoder.decode(decodeBase64(event.dataBase64), { stream: true });
        if (text.length > 0) sink.onChunk({ text, done: false });
      }
      if (event.kind === 'exit') {
        sinks.delete(event.channelId);
        // Whatever the decoder is still holding: a character cut in half by
        // the channel's end is still text the caller has to see.
        const rest = sink.decoder.decode();
        if (rest.length > 0) sink.onChunk({ text: rest, done: false });
        sink.onChunk({ done: true, exitCode: event.exitCode ?? null });
      }
    }).then(() => undefined);
    return listening;
  }

  return {
    async open(command: string, onChunk: (chunk: PiStreamChunk) => void): Promise<PiStreamHandle | null> {
      await ensureListening();
      const session = await openNativeStream(options.target(), command);
      sinks.set(session.channelId, { onChunk, decoder: new TextDecoder('utf-8') });
      return {
        async close(): Promise<void> {
          sinks.delete(session.channelId);
          await session.close();
        },
      };
    },
  };
}
