import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionsStore } from '../../src/stores/connections';
import { installPiLive, type PiLive } from '../../src/session/piLive';
import {
  cachedAgentRoots,
  installAgentRootsStorage,
  PI_AGENT_DIR_PROBE_MARKER,
  type AgentRootsStorage,
} from '../../src/pi/piAgentDir';

function memoryStorage(): AgentRootsStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
  };
}

const kai = { name: 'kai', hostname: '192.168.1.3', port: 22, user: 'kai', keyHandleId: 'h-1' };

function deps() {
  return {
    hosts: {
      savedHosts: () => [kai],
      save: vi.fn(),
      remove: vi.fn(),
      resolve: vi.fn(async (request: { hostAlias?: string }) => ({
        hostId: `${request.hostAlias}@192.168.1.3:22`,
        hostname: '192.168.1.3', port: 22, username: 'kai',
        credential: { kind: 'key-handle', handleId: 'h-1' },
      })),
    },
    port: { connect: vi.fn(async () => ({ ok: true })), disconnect: vi.fn(async () => {}) },
  };
}

/** A live seam whose transport answers the agent-dir probe and records every exec. */
function liveWithProbeAnswer(stdout: string): { commands: string[]; live: PiLive } {
  const commands: string[] = [];
  const transport = {
    exec: async (command: string) => {
      commands.push(command);
      return { stdout, stderr: '', exitCode: 0 };
    },
    sftpRead: async () => '',
  };
  return {
    commands,
    live: {
      transport: () => transport,
      remoteContext: async () => { throw new Error('not used here'); },
      listDirectories: async () => [],
    },
  };
}

afterEach(() => {
  installPiLive(null);
  installAgentRootsStorage(null);
});

describe('connect warms the host agent roots once', () => {
  it('probes on the first connect and answers a later connect from the cache', async () => {
    installAgentRootsStorage(memoryStorage());
    const { commands, live } = liveWithProbeAnswer('env=\nlogin=/home/kai/projects/.pi-agent\n');
    installPiLive(live);

    const store = createConnectionsStore(deps() as never);
    await store.connect('kai');
    await vi.waitFor(() => {
      if (!commands.some((command) => command.startsWith(PI_AGENT_DIR_PROBE_MARKER))) {
        throw new Error('the agent-dir probe was not sent');
      }
    });
    // The warm settles into the durable cache before the second connect.
    await vi.waitFor(() => {
      if (cachedAgentRoots('kai', null) === null) throw new Error('roots not cached yet');
    });
    expect(cachedAgentRoots('kai', null)).toEqual(['/home/kai/projects/.pi-agent']);

    await store.connect('kai');
    // A regression re-probes here; give a wrongly-started probe time to land.
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    expect(commands.filter((command) => command.startsWith(PI_AGENT_DIR_PROBE_MARKER))).toHaveLength(1);
    expect(store.status).toBe('connected');
  });

  it('never fails a connect when no live seam is installed', async () => {
    installAgentRootsStorage(memoryStorage());
    const store = createConnectionsStore(deps() as never);
    await store.connect('kai');
    expect(store.status).toBe('connected');
    expect(store.activeName).toBe('kai');
  });
});
