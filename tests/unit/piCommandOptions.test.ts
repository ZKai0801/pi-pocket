import { describe, expect, it } from 'vitest';
import {
  optionInsertion,
  optionSourceFor,
  parsePiModelList,
  thinkingOptions,
} from '../../src/pi/piCommandOptions';

describe('optionSourceFor', () => {
  it('maps the two commands whose argument is a fixed choice', () => {
    expect(optionSourceFor('/model')).toBe('models');
    expect(optionSourceFor('/thinking')).toBe('thinking');
  });

  it('tolerates the case and padding a caller may carry', () => {
    expect(optionSourceFor(' /Model ')).toBe('models');
    expect(optionSourceFor('/THINKING')).toBe('thinking');
  });

  it('leaves a free-text argument alone, so it is typed not picked', () => {
    expect(optionSourceFor('/name')).toBeNull();
    expect(optionSourceFor('/compact')).toBeNull();
    expect(optionSourceFor('/export')).toBeNull();
    expect(optionSourceFor('/skill:deploy')).toBeNull();
    expect(optionSourceFor('')).toBeNull();
  });
});

describe('thinkingOptions', () => {
  it('lists the levels pi documents, weakest first', () => {
    expect(thinkingOptions().map((option) => option.value)).toEqual([
      'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
  });

  it('describes every level in the active language', () => {
    for (const option of thinkingOptions()) {
      expect(option.label).toBe(option.value);
      expect((option.detail ?? '').length).toBeGreaterThan(0);
    }
  });
});

describe('parsePiModelList', () => {
  it('reads one model per line', () => {
    const models = parsePiModelList('anthropic/claude-sonnet-4\nopenai/gpt-5-codex\n');
    expect(models.map((model) => model.value)).toEqual([
      'anthropic/claude-sonnet-4',
      'openai/gpt-5-codex',
    ]);
  });

  it('splits the provider out as the row detail', () => {
    const [model] = parsePiModelList('anthropic/claude-sonnet-4');
    expect(model.detail).toBe('anthropic');
  });

  it('keeps a bare model id, with no detail', () => {
    const models = parsePiModelList('Beam-1.0-501B-A23B\nsonnet:high');
    expect(models.map((model) => model.value)).toEqual(['Beam-1.0-501B-A23B', 'sonnet:high']);
    expect(models[0].detail).toBeUndefined();
  });

  it('strips colour runs and a header row', () => {
    const stdout = [
      '\u001b[1mProvider  Model  Context\u001b[0m',
      '\u001b[32manthropic/claude-sonnet-4\u001b[0m',
    ].join('\n');
    expect(parsePiModelList(stdout).map((model) => model.value)).toEqual([
      'anthropic/claude-sonnet-4',
    ]);
  });

  it('reduces a table row to its first column', () => {
    const models = parsePiModelList('anthropic/claude-sonnet-4\t200k\t$3/M');
    expect(models.map((model) => model.value)).toEqual(['anthropic/claude-sonnet-4']);
  });

  it('drops a bullet the listing may prefix', () => {
    expect(parsePiModelList('• anthropic/claude-sonnet-4').map((model) => model.value)).toEqual([
      'anthropic/claude-sonnet-4',
    ]);
  });

  it('treats a credentials notice as no models, not as a model named "No"', () => {
    expect(parsePiModelList('No models available\n')).toEqual([]);
    expect(parsePiModelList('')).toEqual([]);
  });

  it('drops repeats ignoring case, keeping the first', () => {
    expect(parsePiModelList('anthropic/Claude\nanthropic/claude\n').map((model) => model.value))
      .toEqual(['anthropic/Claude']);
  });

  it('drops a token that cannot be a model id', () => {
    // A quoted fragment or a path would break the `/model <token>` argument.
    expect(parsePiModelList('"unterminated\n/not/a/model\n')).toEqual([]);
  });
});

describe('optionInsertion', () => {
  it('appends the token after the command', () => {
    expect(optionInsertion('/model', { value: 'openai/gpt-5-codex', label: 'openai/gpt-5-codex' }))
      .toBe('/model openai/gpt-5-codex');
  });

  it('does not double the separator when the command is padded', () => {
    expect(optionInsertion('/thinking ', { value: 'high', label: 'high' })).toBe('/thinking high');
  });
});
