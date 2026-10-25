import { describe, expect, it, vi } from 'vitest';
import { createChatCommandOptions } from '../../src/session/chatCommandOptions';
import type { ModelListBackup } from '../../src/session/chatCommandOptions';
import type { PiCommandOption } from '../../src/pi/piCommandOptions';

const MODELS: PiCommandOption[] = [
  { value: 'anthropic/claude-sonnet-4', label: 'anthropic/claude-sonnet-4', detail: 'anthropic' },
];

const FRESH: PiCommandOption[] = [
  { value: 'anthropic/claude-opus-4', label: 'anthropic/claude-opus-4', detail: 'anthropic' },
];

/** An in-memory backup stand-in with spies, seeded with one host+project. */
function backup(seed: PiCommandOption[] | null = MODELS) {
  const store = new Map<string, PiCommandOption[]>();
  if (seed !== null) store.set('hetzner\n/p', seed);
  const fake: ModelListBackup = {
    load: vi.fn(async (host: string | null, projectPath: string | null) => {
      const key = `${host ?? ''}\n${projectPath ?? ''}`;
      return store.get(key) ?? null;
    }),
    save: vi.fn(async (host: string | null, projectPath: string | null, models: readonly PiCommandOption[]) => {
      store.set(`${host ?? ''}\n${projectPath ?? ''}`, [...models]);
    }),
  };
  return { fake, store };
}

/** Let every pending microtask (the backup read, the paint) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('chat command options', () => {
  it('answers a static source without asking the host', async () => {
    const listModels = vi.fn(async () => MODELS);
    const catalog = createChatCommandOptions({ projectPath: () => '/p', listModels });

    expect(catalog.optionsFor('/thinking').map((option) => option.value)).toContain('high');
    await catalog.load('/thinking');

    expect(listModels).not.toHaveBeenCalled();
    expect(catalog.optionsFor('/name')).toEqual([]);
  });

  it('probes the model list once per project', async () => {
    const listModels = vi.fn(async () => MODELS);
    const catalog = createChatCommandOptions({ projectPath: () => '/p', listModels });

    await catalog.load('/model');
    await catalog.load('/model');

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(catalog.state).toBe('ready');
    expect(catalog.optionsFor('/model').map((option) => option.value))
      .toEqual(['anthropic/claude-sonnet-4']);
  });

  it('joins a probe that is already in flight for the same project', async () => {
    const gate = deferred<PiCommandOption[]>();
    const listModels = vi.fn(() => gate.promise);
    const catalog = createChatCommandOptions({ projectPath: () => '/p', listModels });

    const first = catalog.load('/model');
    const second = catalog.load('/model');
    expect(catalog.state).toBe('loading');
    gate.resolve(MODELS);
    await Promise.all([first, second]);

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(catalog.state).toBe('ready');
  });

  it('drops a probe whose chat moved to another project', async () => {
    const gate = deferred<PiCommandOption[]>();
    let project = '/p';
    const catalog = createChatCommandOptions({
      projectPath: () => project,
      listModels: () => gate.promise,
    });

    const run = catalog.load('/model');
    project = '/other';
    gate.resolve(MODELS);
    await run;

    // The late answer belongs to the old project and must not paint here.
    expect(catalog.optionsFor('/model')).toEqual([]);
  });

  it('flags a rejection, then retries when forced', async () => {
    const listModels = vi.fn()
      .mockRejectedValueOnce(new Error('pi is not installed'))
      .mockResolvedValueOnce(MODELS);
    const catalog = createChatCommandOptions({ projectPath: () => '/p', listModels });

    await catalog.load('/model');
    expect(catalog.state).toBe('error');
    expect(catalog.optionsFor('/model')).toEqual([]);

    await catalog.load('/model', { force: true });
    expect(catalog.state).toBe('ready');
    expect(catalog.optionsFor('/model')).toHaveLength(1);
  });

  it('keeps the host reason for the failed probe, and clears it on retry', async () => {
    // The sheet shows this under the retry: without it, "could not read the
    // model list" is all the user ever sees, whatever the host actually said.
    const listModels = vi.fn()
      .mockRejectedValueOnce(new Error('error: cannot read ~/.pi/agent/models.json'))
      .mockResolvedValueOnce(MODELS);
    const catalog = createChatCommandOptions({ projectPath: () => '/p', listModels });

    await catalog.load('/model');
    expect(catalog.error).toBe('error: cannot read ~/.pi/agent/models.json');

    await catalog.load('/model', { force: true });
    expect(catalog.error).toBeNull();
  });

  it('carries a non-Error rejection as text instead of losing it', async () => {
    const catalog = createChatCommandOptions({
      projectPath: () => '/p',
      listModels: () => Promise.reject('pi --list-models exited 1'),
    });

    await catalog.load('/model');

    expect(catalog.state).toBe('error');
    expect(catalog.error).toBe('pi --list-models exited 1');
  });

  it('does nothing without an open chat', async () => {
    const listModels = vi.fn(async () => MODELS);
    const catalog = createChatCommandOptions({ projectPath: () => null, listModels });

    await catalog.load('/model');

    expect(listModels).not.toHaveBeenCalled();
    expect(catalog.state).toBe('idle');
  });

  it('paints the backup the moment the picker opens, then re-confirms in the background', async () => {
    // The probe is the slowest read in the chat (pi compiles its extension
    // tree before printing), so the rows must be on screen before it lands.
    const gate = deferred<PiCommandOption[]>();
    const listModels = vi.fn(() => gate.promise);
    const store = backup();
    const catalog = createChatCommandOptions({
      projectPath: () => '/p',
      hostName: () => 'hetzner',
      listModels,
      modelListCache: store.fake,
    });

    const run = catalog.load('/model');
    await flush();
    expect(catalog.state).toBe('ready');
    expect(catalog.optionsFor('/model').map((option) => option.value))
      .toEqual(['anthropic/claude-sonnet-4']);
    expect(listModels).toHaveBeenCalledTimes(1);

    gate.resolve(FRESH);
    await run;
    expect(catalog.optionsFor('/model').map((option) => option.value))
      .toEqual(['anthropic/claude-opus-4']);
  });

  it('asks the host once per host+project while the backup answers every open', async () => {
    const listModels = vi.fn(async () => FRESH);
    const store = backup();
    const catalog = createChatCommandOptions({
      projectPath: () => '/p',
      hostName: () => 'hetzner',
      listModels,
      modelListCache: store.fake,
    });

    await catalog.load('/model');
    await catalog.load('/model');
    await catalog.load('/model');

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(store.fake.save).toHaveBeenCalledWith('hetzner', '/p', FRESH);
  });

  it('keeps painted rows when the background refresh fails, without an error', async () => {
    const listModels = vi.fn(async () => Promise.reject(new Error('connection lost')));
    const store = backup();
    const catalog = createChatCommandOptions({
      projectPath: () => '/p',
      hostName: () => 'hetzner',
      listModels,
      modelListCache: store.fake,
    });

    await catalog.load('/model');

    expect(catalog.state).toBe('ready');
    expect(catalog.error).toBeNull();
    expect(catalog.optionsFor('/model')).toEqual(MODELS);
  });

  it('misses the backup for another host and probes that host live', async () => {
    let host = 'hetzner';
    const listModels = vi.fn(async () => MODELS);
    const store = backup();
    const catalog = createChatCommandOptions({
      projectPath: () => '/p',
      hostName: () => host,
      listModels,
      modelListCache: store.fake,
    });

    host = 'laptop';
    await catalog.load('/model');

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(catalog.state).toBe('ready');
    expect(store.fake.save).toHaveBeenCalledWith('laptop', '/p', MODELS);
  });

  it('saves an empty host answer too: no credentials is an answer, not a miss', async () => {
    const listModels = vi.fn(async () => []);
    const store = backup(null);
    const catalog = createChatCommandOptions({
      projectPath: () => '/p',
      hostName: () => 'hetzner',
      listModels,
      modelListCache: store.fake,
    });

    await catalog.load('/model');
    expect(store.fake.save).toHaveBeenCalledWith('hetzner', '/p', []);

    // And the next open is answered by the backup alone (one probe per run).
    listModels.mockClear();
    await catalog.load('/model');
    expect(listModels).not.toHaveBeenCalled();
    expect(catalog.state).toBe('ready');
  });

  it('skips the backup when forced: the retry always probes', async () => {
    const listModels = vi.fn(async () => FRESH);
    const store = backup();
    const catalog = createChatCommandOptions({
      projectPath: () => '/p',
      hostName: () => 'hetzner',
      listModels,
      modelListCache: store.fake,
    });

    await catalog.load('/model', { force: true });

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(catalog.optionsFor('/model').map((option) => option.value))
      .toEqual(['anthropic/claude-opus-4']);
  });

  it('stays silent about the backup with none wired', async () => {
    // No cache dep: the probe is the only answer, as before the backup existed.
    const listModels = vi.fn(async () => MODELS);
    const catalog = createChatCommandOptions({
      projectPath: () => '/p',
      hostName: () => 'hetzner',
      listModels,
    });

    await catalog.load('/model');

    expect(catalog.state).toBe('ready');
    expect(listModels).toHaveBeenCalledTimes(1);
  });
});
