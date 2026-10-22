import { describe, expect, it, vi } from 'vitest';
import { createChatCommandOptions } from '../../src/session/chatCommandOptions';
import type { PiCommandOption } from '../../src/pi/piCommandOptions';

const MODELS: PiCommandOption[] = [
  { value: 'anthropic/claude-sonnet-4', label: 'anthropic/claude-sonnet-4', detail: 'anthropic' },
];

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
});
