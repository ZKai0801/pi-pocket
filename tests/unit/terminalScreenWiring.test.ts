// tests/unit/terminalScreenWiring.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('terminal screen', () => {
  it('reuses TerminalViewport rather than a new emulator', () => {
    const sfc = read('../../src/components/terminal/TerminalScreen.vue');
    expect(sfc).toContain('TerminalViewport');
    expect(sfc).not.toContain('@xterm/xterm');
  });
  it('attaches through the core host-CLI session command', () => {
    expect(read('../../src/components/terminal/TerminalScreen.vue')).toContain('attach');
  });
  it('drives the PTY through the shell-owned seam, not a controller', () => {
    const sfc = read('../../src/components/terminal/TerminalScreen.vue');
    expect(sfc).toContain('terminalPty');
    expect(sfc).not.toContain('ConnectionController');
  });
});
