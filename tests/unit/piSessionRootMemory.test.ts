import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultPiSessionsDir,
  installSessionRootStorage,
  piSessionsDirFor,
  rememberedSessionRoot,
  rememberSessionRoot,
  resolveAndRememberRoot,
  type SessionRootStorage,
} from '../../src/pi/lastSessionRoot';

class MemoryStorage implements SessionRootStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('last successful Pi session root', () => {
  beforeEach(() => installSessionRootStorage(new MemoryStorage()));

  it("remembers the root probed on the host's last successful connect", () => {
    rememberSessionRoot('kai', '/home/projects/.pi-agent/sessions');
    expect(rememberedSessionRoot('kai')).toBe('/home/projects/.pi-agent/sessions');
    expect(defaultPiSessionsDir('', 'kai')).toBe('/home/projects/.pi-agent/sessions');
  });

  it('prefers a saved per-host directory over the remembered root', () => {
    rememberSessionRoot('kai', '/probed');
    expect(defaultPiSessionsDir('/saved', 'kai')).toBe('/saved');
  });

  it('returns blank when the host has neither a saved directory nor a remembered root', () => {
    expect(rememberedSessionRoot('other')).toBeNull();
    expect(defaultPiSessionsDir(undefined, 'other')).toBe('');
    expect(defaultPiSessionsDir('', null)).toBe('');
  });

  it('ignores a blank host name or a blank root', () => {
    rememberSessionRoot(null, '/probed');
    rememberSessionRoot('kai', '');
    expect(rememberedSessionRoot(null)).toBeNull();
    expect(rememberedSessionRoot('kai')).toBeNull();
  });

  it('remembers a resolved root and offers it to the editor default', async () => {
    const root = await resolveAndRememberRoot('kai', async () => '/probed');

    expect(root).toBe('/probed');
    expect(rememberedSessionRoot('kai')).toBe('/probed');
    expect(piSessionsDirFor({ name: 'kai' })).toBe('/probed');
  });

  it('does not remember a null root', async () => {
    expect(await resolveAndRememberRoot('kai', async () => null)).toBeNull();
    expect(rememberedSessionRoot('kai')).toBeNull();
  });
});
