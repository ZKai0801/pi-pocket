/**
 * The native PTY channel budget the chat's turn PTY rides (R18.3, D45): core
 * is told how many channels per connection the Android plugin allows, so the
 * controller keeps exec headroom beside the openPty/readPty/writePty channels
 * PhoneApp opens for turn runs (src/phone/PhoneApp.vue). The attach hub this
 * file used to exercise (#2955) is gone from the chat-only cut; the one PTY
 * lifecycle the phone still has is the turn PTY over the native verbs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PTY_CHANNEL_RESERVE } from '@pocketshell/core';
import {
  adaptSshCapabilityPlugin,
  NATIVE_MAX_CHANNELS_PER_CONNECTION,
  type NativeSshCapabilityPlugin,
} from '@/native/sshCapability';

describe('Android native PTY channel budget', () => {
  it('states the native per-connection channel budget to core, so the controller keeps exec headroom', () => {
    const plugin = readFileSync(path.join(process.cwd(), 'android/app/src/main/java/com/pocketshell/app/SshCapabilityPlugin.java'), 'utf8');
    expect(plugin).toMatch(new RegExp(`MAX_CHANNELS_PER_CONNECTION = ${NATIVE_MAX_CHANNELS_PER_CONNECTION};`));
    // Capacitor's plugin proxy answers ANY property with a native method; the adapter must not reach it.
    const capacitorLike = new Proxy({}, { get: () => () => Promise.reject(new Error('native call')) });
    const capability = adaptSshCapabilityPlugin(capacitorLike as unknown as NativeSshCapabilityPlugin);
    expect(capability.maxChannelsPerConnection).toBe(NATIVE_MAX_CHANNELS_PER_CONNECTION);
    expect(NATIVE_MAX_CHANNELS_PER_CONNECTION - PTY_CHANNEL_RESERVE).toBeGreaterThanOrEqual(1);
  });
});
