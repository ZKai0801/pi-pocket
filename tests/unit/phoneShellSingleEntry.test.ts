import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('single shell', () => {
  it('main.ts mounts the phone app unconditionally', () => {
    const main = read('../../src/main.ts');
    expect(main).toContain('./phone/PhoneApp.vue');
    expect(main).not.toContain('sharedApp');
    expect(main).not.toContain('selectShell');
  });
  it('capacitor starts on the phone app, not a shell query', () => {
    expect(read('../../capacitor.config.ts')).not.toContain('shell=shared');
  });
});
