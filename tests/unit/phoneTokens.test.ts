import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
const REQUIRED = ['--chat-bg', '--bubble-self-bg', '--bubble-self-fg',
  '--bubble-other-bg', '--bubble-other-fg', '--tabbar-active', '--tabbar-bg', '--tabbar-fg'];

describe('phone token layer', () => {
  it('declares every WeChat role the phone UI needs', () => {
    for (const token of REQUIRED) expect(css).toContain(`${token}:`);
  });
  it('declares them from existing tokens, not raw hex', () => {
    const block = css.slice(css.indexOf('--chat-bg:'));
    for (const token of REQUIRED) {
      const line = block.split('\n').find((l) => l.trim().startsWith(`${token}:`));
      expect(line, token).toBeDefined();
      expect(line, token).toMatch(/var\(--/);
    }
  });
});
