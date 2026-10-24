import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ROOTS_STORAGE_KEY,
  PI_AGENT_DIR_ENV,
  PI_AGENT_DIR_PROBE_MARKER,
  agentDirRoots,
  agentRootsForConnection,
  agentRootsForHost,
  cachedAgentRoots,
  installAgentRootsStorage,
  parsePiAgentDirProbe,
  piAgentDirProbeCommand,
  rememberAgentRoots,
  resolvePiAgentRoots,
  sessionRootHintForHost,
  type AgentRootsStorage,
} from '../../src/pi/piAgentDir';
import { installSessionRootStorage, rememberSessionRoot } from '../../src/pi/lastSessionRoot';
import type { PiTransport } from '../../src/pi/piRepository';

function memoryStorage(): AgentRootsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
  };
}

/** A transport whose exec answers per call; every sent command is recorded. */
function scriptedTransport(
  answers: Array<{ stdout?: string; stderr?: string; exitCode?: number } | Error>,
): PiTransport & { commands: string[] } {
  const commands: string[] = [];
  let call = 0;
  return {
    commands,
    exec: async (command) => {
      commands.push(command);
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      if (answer instanceof Error) throw answer;
      return {
        stdout: answer?.stdout ?? '',
        stderr: answer?.stderr ?? '',
        exitCode: answer?.exitCode ?? 0,
      };
    },
    sftpRead: async () => '',
  };
}

describe('piAgentDirProbeCommand', () => {
  it('reads the variable in both env readings and stays POSIX', () => {
    const command = piAgentDirProbeCommand();
    const lines = command.split('\n');
    expect(lines[0]).toBe(PI_AGENT_DIR_PROBE_MARKER);
    expect(command).toContain(`printf 'env=%s\\n' "\${${PI_AGENT_DIR_ENV}-}"`);
    expect(command).toContain('bash -l -c ');
    expect(command).toContain('login=%s\\n');
    // A missing bash degrades to silence instead of failing the whole probe.
    expect(command).toContain('command -v bash >/dev/null 2>&1 &&');
    expect(lines.at(-1)).toBe('true');
  });
});

describe('parsePiAgentDirProbe', () => {
  it('reads both values and tolerates carriage returns', () => {
    expect(parsePiAgentDirProbe('env=/home/kai/projects/.pi-agent\r\nlogin=/elsewhere\r\n'))
      .toEqual({ env: '/home/kai/projects/.pi-agent', login: '/elsewhere' });
  });

  it('keeps empty, absent and repeated readings as null or first-wins', () => {
    expect(parsePiAgentDirProbe('env=\nlogin=\n')).toEqual({ env: null, login: null });
    expect(parsePiAgentDirProbe('')).toEqual({ env: null, login: null });
    expect(parsePiAgentDirProbe('env=/first\nenv=/second\n')).toEqual({ env: '/first', login: null });
  });
});

describe('agentDirRoots', () => {
  it('orders by evidence, dedupes and derives the session root parent', () => {
    expect(agentDirRoots({
      env: '/home/kai/projects/.pi-agent',
      login: '/home/kai/projects/.pi-agent',
      sessionRoot: '/home/kai/projects/.pi-agent/sessions',
    })).toEqual(['/home/kai/projects/.pi-agent']);

    expect(agentDirRoots({
      env: null,
      login: '/login/agent',
      sessionRoot: '/sessions-root/sessions',
    })).toEqual(['/login/agent', '/sessions-root']);
  });

  it('drops values that could not be directories', () => {
    expect(agentDirRoots({ env: 'relative/path', login: ' ', sessionRoot: '/root/sessions' }))
      .toEqual(['/root']);
    expect(agentDirRoots({ env: null, login: null, sessionRoot: null })).toEqual([]);
    expect(agentDirRoots({ sessionRoot: '/sessions' })).toEqual([]);
  });
});

describe('resolvePiAgentRoots', () => {
  it('merges the probe answer with the session-root parent', async () => {
    const transport = scriptedTransport([{ stdout: 'env=\nlogin=/login/agent\n' }]);
    const resolution = await resolvePiAgentRoots(transport, {
      sessionRoot: '/home/kai/projects/.pi-agent/sessions',
    });
    expect(resolution.answer).toEqual({ env: null, login: '/login/agent' });
    expect(resolution.roots).toEqual(['/login/agent', '/home/kai/projects/.pi-agent']);
  });

  it('keeps the session-root hint through a transport fault', async () => {
    const transport = scriptedTransport([new Error('channel closed')]);
    const resolution = await resolvePiAgentRoots(transport, {
      sessionRoot: '/home/kai/projects/.pi-agent/sessions',
    });
    expect(resolution.answer).toEqual({ env: null, login: null });
    expect(resolution.roots).toEqual(['/home/kai/projects/.pi-agent']);
  });
});

describe('sessionRootHintForHost', () => {
  beforeEach(() => {
    installAgentRootsStorage(memoryStorage());
    installSessionRootStorage(memoryStorage());
  });

  afterEach(() => {
    installAgentRootsStorage(null);
    installSessionRootStorage(null);
  });

  it('prefers the configured override, else the remembered root', () => {
    rememberSessionRoot('kai-server', '/remembered/sessions');
    expect(sessionRootHintForHost({ name: 'kai-server', piSessionsDir: '/override/sessions' }))
      .toBe('/override/sessions');
    expect(sessionRootHintForHost({ name: 'kai-server', piSessionsDir: '  ' }))
      .toBe('/remembered/sessions');
    expect(sessionRootHintForHost({ name: 'unknown-host', piSessionsDir: null })).toBeNull();
  });

  it('feeds the hint into a connection-scoped resolution', async () => {
    rememberSessionRoot('kai-server', '/home/kai/projects/.pi-agent/sessions');
    const transport = scriptedTransport([{ stdout: 'env=\nlogin=\n' }]);
    const resolution = await agentRootsForConnection(transport, {
      name: 'kai-server',
      piSessionsDir: undefined,
    });
    expect(resolution.roots).toEqual(['/home/kai/projects/.pi-agent']);
  });
});

describe('agent roots host cache', () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
    installAgentRootsStorage(storage);
  });

  afterEach(() => {
    installAgentRootsStorage(null);
  });

  it('remembers per host and invalidates on a moved session root', () => {
    rememberAgentRoots('kai-server', '/a/sessions', ['/a']);
    expect(cachedAgentRoots('kai-server', '/a/sessions')).toEqual(['/a']);
    expect(cachedAgentRoots('kai-server', '/b/sessions')).toBeNull();
    expect(cachedAgentRoots('other-host', '/a/sessions')).toBeNull();
  });

  it('survives corrupt storage and a null session root', () => {
    storage.data.set(AGENT_ROOTS_STORAGE_KEY, '{not json');
    expect(cachedAgentRoots('kai-server', '/a/sessions')).toBeNull();
    rememberAgentRoots('kai-server', null, ['/a']);
    expect(cachedAgentRoots('kai-server', null)).toEqual(['/a']);
  });

  it('resolves once per host and session root, then answers from the cache', async () => {
    const transport = scriptedTransport([{ stdout: 'env=/agent-from-env\nlogin=\n' }]);
    const first = await agentRootsForHost(transport, { name: 'kai-server', sessionRoot: '/a/sessions' });
    const second = await agentRootsForHost(transport, { name: 'kai-server', sessionRoot: '/a/sessions' });
    expect(first.roots).toEqual(['/agent-from-env', '/a']);
    expect(second.roots).toEqual(first.roots);
    expect(transport.commands).toHaveLength(1);
    // A concurrent open coalesces into the same in-flight probe.
    const [a, b] = await Promise.all([
      agentRootsForHost(transport, { name: 'kai-server', sessionRoot: '/b/sessions' }),
      agentRootsForHost(transport, { name: 'kai-server', sessionRoot: '/b/sessions' }),
    ]);
    expect(a.roots).toEqual(b.roots);
    expect(transport.commands).toHaveLength(2);
  });
});
