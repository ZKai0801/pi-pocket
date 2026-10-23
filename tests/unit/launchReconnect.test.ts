import { beforeEach, describe, expect, it } from 'vitest';
import {
  decideLaunchReconnect,
  launchReconnectAttempted,
  markLaunchReconnectAttempted,
  resetLaunchReconnectLatch,
} from '../../src/phone/launchReconnect';

/**
 * The cold-start dial is a trap risk: re-deciding on every mount is how a
 * remembered host the user cannot reach becomes a loop they cannot escape,
 * and deciding over a live connection is how Back bounces them straight back
 * into the session they just left. Each rule below is one call.
 */
describe('launch reconnect decision', () => {
  beforeEach(() => {
    resetLaunchReconnectLatch();
  });

  it('dials the remembered host on a cold start', () => {
    expect(decideLaunchReconnect({
      lastHost: 'hetzner',
      hostNames: ['hetzner', 'laptop'],
      attempted: false,
      connected: false,
    })).toEqual({ action: 'connect', name: 'hetzner' });
  });

  it('never dials twice in one launch', () => {
    markLaunchReconnectAttempted();
    expect(launchReconnectAttempted()).toBe(true);
    expect(decideLaunchReconnect({
      lastHost: 'hetzner',
      hostNames: ['hetzner'],
      attempted: launchReconnectAttempted(),
      connected: false,
    })).toEqual({ action: 'skip', reason: 'already-attempted' });
  });

  it('leaves a live connection alone', () => {
    expect(decideLaunchReconnect({
      lastHost: 'hetzner',
      hostNames: ['hetzner'],
      attempted: false,
      connected: true,
    })).toEqual({ action: 'skip', reason: 'already-connected' });
  });

  it('defers while the saved hosts have not loaded, without latching', () => {
    // The host list arrives from a dynamic import; a mount that beats it must
    // decide again when the list lands, not latch on an empty list forever.
    expect(decideLaunchReconnect({
      lastHost: 'hetzner',
      hostNames: [],
      attempted: false,
      connected: false,
    })).toEqual({ action: 'skip', reason: 'no-hosts' });
    expect(launchReconnectAttempted()).toBe(false);
  });

  it('does nothing when nothing was ever connected', () => {
    expect(decideLaunchReconnect({
      lastHost: null,
      hostNames: ['hetzner'],
      attempted: false,
      connected: false,
    })).toEqual({ action: 'skip', reason: 'no-last-host' });
    expect(decideLaunchReconnect({
      lastHost: '  ',
      hostNames: ['hetzner'],
      attempted: false,
      connected: false,
    })).toEqual({ action: 'skip', reason: 'no-last-host' });
  });

  it('skips a remembered host that was renamed or deleted, rather than erroring', () => {
    expect(decideLaunchReconnect({
      lastHost: 'old-box',
      hostNames: ['hetzner'],
      attempted: false,
      connected: false,
    })).toEqual({ action: 'skip', reason: 'unknown-host' });
  });

  it('skips when the remembered value is an endpoint rather than an alias', () => {
    // A dial target identifies a host as `user@host:port`; the saved list is
    // keyed by name. Remembering the endpoint must be a plain skip that shows
    // up in a test, not a dial that silently never happens.
    expect(decideLaunchReconnect({
      lastHost: 'alexey@135.181.114.209:22',
      hostNames: ['hetzner'],
      attempted: false,
      connected: false,
    })).toEqual({ action: 'skip', reason: 'unknown-host' });
  });

  it('checks the latch and the live connection before the remembered host', () => {
    // An unreachable remembered host must not be consulted at all once this
    // launch already tried: the user is on the host list because they chose to
    // be, or because the attempt failed.
    markLaunchReconnectAttempted();
    expect(decideLaunchReconnect({
      lastHost: 'gone',
      hostNames: ['hetzner'],
      attempted: launchReconnectAttempted(),
      connected: false,
    }).action).toBe('skip');
  });
});
