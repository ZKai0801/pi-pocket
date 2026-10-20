import { describe, expect, it, vi } from 'vitest';
import type { PiTurnRunner } from '../../src/pi/piTurnRunner';
import { createTurnRunnerCache, type TurnRunnerCacheDeps } from '../../src/stores/sessions';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type StubRunner = PiTurnRunner & { dispose: ReturnType<typeof vi.fn>; isBusy: ReturnType<typeof vi.fn> };

function stubRunner(): StubRunner {
  return {
    send: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
    startNew: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
    isBusy: vi.fn(() => false),
    dispose: vi.fn(),
  };
}

function cacheWith(overrides: Partial<TurnRunnerCacheDeps> = {}) {
  const built: StubRunner[] = [];
  const build = vi.fn((command: string, projectPath: string) => {
    const runner = overrides.build
      ? (overrides.build(command, projectPath) as StubRunner)
      : stubRunner();
    built.push(runner);
    return runner;
  });
  const resolveCommand = vi.fn(() =>
    overrides.resolveCommand
      ? overrides.resolveCommand()
      : Promise.resolve({ ok: true as const, command: '/usr/bin/pi' }),
  );
  const cache = createTurnRunnerCache({
    hostId: () => 'A',
    openPath: () => '/r/a.jsonl',
    projectPath: () => '/p/a',
    ...overrides,
    resolveCommand,
    build,
  });
  return { cache, build, built, resolveCommand };
}

const STALE = 'The chat changed before the turn could start.';

describe('turn runner cache', () => {
  it('builds one runner for a host and chat and reuses it afterwards', async () => {
    const { cache, build, resolveCommand } = cacheWith();

    const first = await cache.runnerFor('/r/a.jsonl');
    const second = await cache.runnerFor('/r/a.jsonl');

    expect(second).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
    expect(resolveCommand).toHaveBeenCalledTimes(1);
  });

  it('captures the claim before the command probe so a stale build cannot open another chat\'s directory', async () => {
    const probe = deferred<{ ok: true; command: string }>();
    let path = '/r/a.jsonl';
    let project = '/p/a';
    const { cache, build } = cacheWith({
      openPath: () => path,
      projectPath: () => project,
      resolveCommand: () => probe.promise,
    });

    const stale = cache.runnerFor('/r/a.jsonl');
    path = '/r/b.jsonl';
    project = '/p/b';
    probe.resolve({ ok: true, command: '/usr/bin/pi' });

    await expect(stale).rejects.toThrow(STALE);
    expect(build).not.toHaveBeenCalled();

    await cache.runnerFor('/r/b.jsonl');
    expect(build).toHaveBeenLastCalledWith('/usr/bin/pi', '/p/b');
  });

  it('refuses and does not cache a build whose host was disposed while the probe ran', async () => {
    const probe = deferred<{ ok: true; command: string }>();
    let host = 'A';
    const { cache, build, resolveCommand } = cacheWith({
      hostId: () => host,
      resolveCommand: () => probe.promise,
    });

    const stale = cache.runnerFor('/r/a.jsonl');
    host = 'B';
    cache.dispose();
    probe.resolve({ ok: true, command: '/usr/bin/pi' });

    await expect(stale).rejects.toThrow(STALE);
    expect(build).not.toHaveBeenCalled();

    await cache.runnerFor('/r/a.jsonl');
    expect(resolveCommand).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('disposes and refuses a runner that went stale while it was built', async () => {
    const built: StubRunner[] = [];
    let path = '/r/a.jsonl';
    const { cache } = cacheWith({
      openPath: () => path,
      build: () => {
        const runner = stubRunner();
        built.push(runner);
        path = '/r/b.jsonl';
        return runner;
      },
    });

    await expect(cache.runnerFor('/r/a.jsonl')).rejects.toThrow(STALE);
    expect(built).toHaveLength(1);
    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the chat runner on a chat close but keeps the resolved command', async () => {
    const { cache, build, built, resolveCommand } = cacheWith();

    await cache.runnerFor('/r/a.jsonl');
    cache.disposeChat();
    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);

    await cache.runnerFor('/r/a.jsonl');
    expect(build).toHaveBeenCalledTimes(2);
    expect(resolveCommand).toHaveBeenCalledTimes(1);
  });

  it('refuses without a project directory and never probes the shell', async () => {
    const { cache, build, resolveCommand } = cacheWith({ projectPath: () => null });

    await expect(cache.runnerFor('/r/a.jsonl')).rejects.toThrow('会话缺少项目目录，无法发送。');
    expect(resolveCommand).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it('propagates a failed command resolution without building a runner', async () => {
    const { cache, build } = cacheWith({
      resolveCommand: async () => ({ ok: false as const, error: '未找到可执行的 pi。' }),
    });

    await expect(cache.runnerFor('/r/a.jsonl')).rejects.toThrow('未找到可执行的 pi。');
    expect(build).not.toHaveBeenCalled();
  });

  it('refuses a chat that is no longer open before probing', async () => {
    const { cache, build, resolveCommand } = cacheWith({ openPath: () => '/r/b.jsonl' });

    await expect(cache.runnerFor('/r/a.jsonl')).rejects.toThrow(STALE);
    expect(resolveCommand).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it('builds one draft runner for the empty session key and the open project', async () => {
    const { cache, build, built } = cacheWith({
      openPath: () => null,
      projectPath: () => '/p/a',
    });

    const first = await cache.runnerFor('');
    const second = await cache.runnerFor('');

    expect(second).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith('/usr/bin/pi', '/p/a');
    expect(built[0]?.dispose).not.toHaveBeenCalled();
  });

  it('refuses a draft build whose project changed while the probe ran', async () => {
    const probe = deferred<{ ok: true; command: string }>();
    let project = '/p/a';
    const { cache, build } = cacheWith({
      openPath: () => null,
      projectPath: () => project,
      resolveCommand: () => probe.promise,
    });

    const stale = cache.runnerFor('');
    project = '/p/b';
    probe.resolve({ ok: true, command: '/usr/bin/pi' });

    await expect(stale).rejects.toThrow(STALE);
    expect(build).not.toHaveBeenCalled();
  });

  it('refuses a draft build whose host changed while the probe ran', async () => {
    const probe = deferred<{ ok: true; command: string }>();
    let host = 'A';
    const { cache, build } = cacheWith({
      hostId: () => host,
      openPath: () => null,
      projectPath: () => '/p/a',
      resolveCommand: () => probe.promise,
    });

    const stale = cache.runnerFor('');
    host = 'B';
    probe.resolve({ ok: true, command: '/usr/bin/pi' });

    await expect(stale).rejects.toThrow(STALE);
    expect(build).not.toHaveBeenCalled();
  });
});
