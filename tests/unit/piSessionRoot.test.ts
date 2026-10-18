import { describe, expect, it } from 'vitest';
import { PI_SESSION_DIR_ENV, candidateSessionRoots } from '../../src/pi/sessionRoot';

describe('candidateSessionRoots', () => {
  it('puts the per-host override first', () => {
    const roots = candidateSessionRoots('/home/kai', {}, '/home/projects/.pi-agent/sessions');
    expect(roots[0]).toBe('/home/projects/.pi-agent/sessions');
  });

  it('uses the env var second', () => {
    const roots = candidateSessionRoots('/home/kai', { [PI_SESSION_DIR_ENV]: '/srv/pi/sessions' });
    expect(roots[0]).toBe('/srv/pi/sessions');
  });

  it('falls back to the two home-relative defaults in order', () => {
    expect(candidateSessionRoots('/home/kai', {})).toEqual([
      '/home/kai/.pi-agent/sessions',
      '/home/kai/.pi/agent/sessions',
    ]);
  });

  it('ignores a blank override', () => {
    expect(candidateSessionRoots('/home/kai', {}, '   ')[0]).toBe('/home/kai/.pi-agent/sessions');
  });
});
