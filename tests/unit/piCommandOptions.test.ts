import { describe, expect, it } from 'vitest';
import {
  optionInsertion,
  optionSourceFor,
  parsePiModelList,
  piModelListOutcome,
  piReportsNoModels,
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
  // The real shape, copied from pi 0.73's `listModels`: a header row, then
  // `padEnd`-ed columns joined by two spaces, provider first.
  const TABLE = [
    'provider   model                   context  max-out  thinking  images',
    'anthropic  claude-sonnet-4-5       200K     64K      yes       yes',
    'openai     gpt-5.1-codex           400K     128K     yes       yes',
  ].join('\n');

  it('reads the table: provider column plus model column', () => {
    expect(parsePiModelList(TABLE).map((model) => model.value)).toEqual([
      'anthropic/claude-sonnet-4-5',
      'openai/gpt-5.1-codex',
    ]);
  });

  it('labels a row with the model and details it with the provider', () => {
    const [model] = parsePiModelList(TABLE);
    expect(model.label).toBe('claude-sonnet-4-5');
    expect(model.detail).toBe('anthropic');
  });

  it('does not mistake the provider column for the model', () => {
    // The bug this parser shipped with: the first token of a table row is the
    // provider, so `/model anthropic` was offered instead of a model id.
    expect(parsePiModelList(TABLE).map((model) => model.value)).not.toContain('anthropic');
  });

  it('reads a single-column listing of full ids', () => {
    const models = parsePiModelList('anthropic/claude-sonnet-4\nopenai/gpt-5-codex\n');
    expect(models.map((model) => model.value)).toEqual([
      'anthropic/claude-sonnet-4',
      'openai/gpt-5-codex',
    ]);
    expect(models[0].detail).toBe('anthropic');
  });

  it('keeps a bare model id, with no detail', () => {
    const models = parsePiModelList('Beam-1.0-501B-A23B\nsonnet:high');
    expect(models.map((model) => model.value)).toEqual(['Beam-1.0-501B-A23B', 'sonnet:high']);
    expect(models[0].detail).toBeUndefined();
  });

  it('strips colour runs and the header row', () => {
    const stdout = [
      '\u001b[1mprovider   model\u001b[0m',
      '\u001b[32manthropic  claude-sonnet-4\u001b[0m',
    ].join('\n');
    expect(parsePiModelList(stdout).map((model) => model.value)).toEqual([
      'anthropic/claude-sonnet-4',
    ]);
  });

  it('reads a tab-separated row as a table row', () => {
    const models = parsePiModelList('anthropic\tclaude-sonnet-4\t200k\t$3/M');
    expect(models.map((model) => model.value)).toEqual(['anthropic/claude-sonnet-4']);
  });

  it('keeps a full id that carries its own trailing columns', () => {
    const models = parsePiModelList('anthropic/claude-sonnet-4\t200k\t$3/M');
    expect(models.map((model) => model.value)).toEqual(['anthropic/claude-sonnet-4']);
  });

  it('drops a bullet the listing may prefix', () => {
    expect(parsePiModelList('• anthropic/claude-sonnet-4').map((model) => model.value)).toEqual([
      'anthropic/claude-sonnet-4',
    ]);
    expect(parsePiModelList('•  anthropic/claude-sonnet-4').map((model) => model.value)).toEqual([
      'anthropic/claude-sonnet-4',
    ]);
  });

  it('treats a credentials notice as no models, not as a model named "No"', () => {
    expect(parsePiModelList('No models available. Use /login to log in to a provider via OAuth or API key. See:\n'))
      .toEqual([]);
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

describe('piReportsNoModels', () => {
  it('recognises the guidance pi prints when nothing has credentials', () => {
    expect(piReportsNoModels('No models available. Use /login to log in to a provider.')).toBe(true);
  });

  it('does not answer for a table, so a format change stays visible', () => {
    expect(piReportsNoModels('provider   model\nanthropic  claude-sonnet-4\n')).toBe(false);
    expect(piReportsNoModels('')).toBe(false);
  });
});

describe('piModelListOutcome', () => {
  const TABLE = 'provider   model\nanthropic  claude-sonnet-4-5\n';

  it('returns the rows of a good run and no failure', () => {
    const outcome = piModelListOutcome(TABLE, '', 0);
    expect(outcome.models.map((model) => model.value)).toEqual(['anthropic/claude-sonnet-4-5']);
    expect(outcome.failure).toBeNull();
  });

  it('treats "no models available" as an empty list, not a failure', () => {
    const stdout = 'No models available. Use /login to log in to a provider via OAuth or API key. See:\n  ~/.pi/agent/docs/providers.md\n';
    const outcome = piModelListOutcome(stdout, '', 0);
    expect(outcome.models).toEqual([]);
    expect(outcome.failure).toBeNull();
  });

  it('reports a failed run with the reason from stderr', () => {
    // The whole point: pi explains the failure on stderr, and the sheet shows
    // it instead of a bare "could not read the model list".
    const outcome = piModelListOutcome('', 'error: cannot read ~/.pi/agent/models.json\n', 1);
    expect(outcome.models).toEqual([]);
    expect(outcome.failure).toBe('error: cannot read ~/.pi/agent/models.json');
  });

  it('skips a leading warning to reach the actual error', () => {
    const stderr = 'Warning: errors loading models.json:\n  unexpected token }\nError: extension failed to load\n';
    expect(piModelListOutcome('', stderr, 1).failure).toBe('Error: extension failed to load');
  });

  it('falls back to stdout when a failed run wrote nothing to stderr', () => {
    expect(piModelListOutcome('collecting models...\n', '', 3).failure).toBe('collecting models...');
  });

  it('still says something when a failed run printed nothing at all', () => {
    expect(piModelListOutcome('', '', 1).failure).toBe('pi --list-models exited 1');
    expect(piModelListOutcome('', '', null).failure).toBe('pi --list-models exited unknown');
  });

  it('surfaces a shape change instead of claiming the host has no models', () => {
    // Exit 0 with rows nobody can parse is a format change, and it must be
    // visible: silence here is how the provider-column bug survived.
    const outcome = piModelListOutcome('something new\nand longer\n', '', 0);
    expect(outcome.models).toEqual([]);
    expect(outcome.failure).toBe('something new');
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
