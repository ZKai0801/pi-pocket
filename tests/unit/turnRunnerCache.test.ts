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

type StubRunner = PiTurnRunner & {
  dispose: ReturnType<typeof vi.fn>;
  isBusy: ReturnType<typeof vi.fn>;
  rebind: ReturnType<typeof vi.fn>;
};

function stubRunner(): StubRunner {
  return {
    send: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
    startNew: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
    runCommand: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
    beginSend: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
    beginStartNew: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
    queue: vi.fn(async () => ({ ok: false as const, error: 'unused' })),
    rebind: vi.fn(),
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
    projectPath: () => '/p/a',
    ...overrides,
    resolveCommand,
    build,
  });
  return { cache, build, built, resolveCommand };
}

const STALE = 'The chat changed before the turn could start.';

describe('turn runner cache', () => {
  it('builds one runner for a host and conversation and reuses it afterwards', async () => {
    const { cache, build, resolveCommand } = cacheWith();

    const first = await cache.runnerFor('/r/a.jsonl');
    const second = await cache.runnerFor('/r/a.jsonl');

    expect(second).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
    expect(resolveCommand).toHaveBeenCalledTimes(1);
  });

  it('keeps another conversation\'s runner when a second chat sends', async () => {
    const { cache, build, built } = cacheWith();

    const first = await cache.runnerFor('/r/a.jsonl');
    const second = await cache.runnerFor('/r/b.jsonl');

    expect(second).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(2);
    // A turn still running in the first chat must not lose its PTY.
    expect(built[0]?.dispose).not.toHaveBeenCalled();
    await expect(cache.runnerFor('/r/a.jsonl')).resolves.toBe(first);
  });

  it('rebinds every cached runner on a reconnect instead of disposing it', async () => {
    const { cache, built } = cacheWith();

    await cache.runnerFor('/r/a.jsonl');
    await cache.runnerFor('/r/b.jsonl');
    cache.rebind();

    // A transport change is not a turn's end: each runner drops its dead
    // handle and keeps its run (which is what makes a live turn survive).
    for (const runner of built) {
      expect(runner.rebind).toHaveBeenCalledTimes(1);
      expect(runner.dispose).not.toHaveBeenCalled();
    }
  });

  it('captures the claim before the command probe so a stale build cannot open another directory', async () => {
    const probe = deferred<{ ok: true; command: string }>();
    let project = '/p/a';
    const { cache, build } = cacheWith({
      projectPath: () => project,
      resolveCommand: () => probe.promise,
    });

    const stale = cache.runnerFor('/r/a.jsonl');
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
    let project = '/p/a';
    const { cache } = cacheWith({
      projectPath: () => project,
      build: () => {
        const runner = stubRunner();
        built.push(runner);
        project = '/p/b';
        return runner;
      },
    });

    await expect(cache.runnerFor('/r/a.jsonl')).rejects.toThrow(STALE);
    expect(built).toHaveLength(1);
    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('drops only the released conversation and keeps the resolved command', async () => {
    const { cache, build, built, resolveCommand } = cacheWith();

    await cache.runnerFor('/r/a.jsonl');
    const other = await cache.runnerFor('/r/b.jsonl');
    cache.release('/r/a.jsonl');

    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(built[1]?.dispose).not.toHaveBeenCalled();
    await expect(cache.runnerFor('/r/b.jsonl')).resolves.toBe(other);

    await cache.runnerFor('/r/a.jsonl');
    expect(build).toHaveBeenCalledTimes(3);
    expect(resolveCommand).toHaveBeenCalledTimes(1);
  });

  it('releases every conversation on releaseAll but keeps the command cache', async () => {
    const { cache, build, built, resolveCommand } = cacheWith();

    await cache.runnerFor('/r/a.jsonl');
    await cache.runnerFor('/r/b.jsonl');
    cache.releaseAll();

    expect(built[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(built[1]?.dispose).toHaveBeenCalledTimes(1);

    await cache.runnerFor('/r/a.jsonl');
    expect(build).toHaveBeenCalledTimes(3);
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

  it('builds one draft runner for the empty session key and the open project', async () => {
    const { cache, build, built } = cacheWith();

    const first = await cache.runnerFor('');
    const second = await cache.runnerFor('');

    expect(second).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith('/usr/bin/pi', '/p/a');
    expect(built[0]?.dispose).not.toHaveBeenCalled();
  });

  it('gives each project its own draft runner instead of evicting the running one', async () => {
    let project = '/p/a';
    const { cache, build, built } = cacheWith({ projectPath: () => project });

    const first = await cache.runnerFor('');
    project = '/p/b';
    const second = await cache.runnerFor('');

    expect(second).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(2);
    expect(built[0]?.dispose).not.toHaveBeenCalled();
    expect(build).toHaveBeenLastCalledWith('/usr/bin/pi', '/p/b');
  });

  it('leaves a runner that is still running its turn alone when released', async () => {
    const busy = stubRunner();
    busy.isBusy.mockReturnValue(true);
    let builds = 0;
    const { cache, build } = cacheWith({ build: () => (builds++ === 0 ? busy : stubRunner()) });

    const runner = await cache.runnerFor('/r/a.jsonl');
    cache.release('/r/a.jsonl');

    expect(busy.dispose).not.toHaveBeenCalled();
    // Still cached: the turn's own settlement releases it.
    await expect(cache.runnerFor('/r/a.jsonl')).resolves.toBe(runner);
    expect(build).toHaveBeenCalledTimes(1);

    busy.isBusy.mockReturnValue(false);
    cache.release('/r/a.jsonl');
    expect(busy.dispose).toHaveBeenCalledTimes(1);

    await expect(cache.runnerFor('/r/a.jsonl')).resolves.not.toBe(runner);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('refuses a draft build whose project changed while the probe ran', async () => {
    const probe = deferred<{ ok: true; command: string }>();
    let project = '/p/a';
    const { cache, build } = cacheWith({
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
      resolveCommand: () => probe.promise,
    });

    const stale = cache.runnerFor('');
    host = 'B';
    probe.resolve({ ok: true, command: '/usr/bin/pi' });

    await expect(stale).rejects.toThrow(STALE);
    expect(build).not.toHaveBeenCalled();
  });
});
