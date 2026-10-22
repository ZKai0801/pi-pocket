/**
 * The second step a few pi slash commands need: `/model` wants a model,
 * `/thinking` a level. Both are typed as a text argument (`/model
 * provider/model`, `/thinking high`), so the sheet can complete the command
 * here instead of letting the bare form reach pi — whose own picker draws into
 * the turn PTY, where this chat cannot show it.
 *
 * Two sources, matching the command catalog's split:
 *
 * 1. `THINKING_LEVELS` — pi documents a fixed set of levels, so this is
 *    app-shipped copy.
 * 2. `parsePiModelList` — whatever `pi --list-models` reports on the host,
 *    because which models exist is credentials-dependent (pi lists only the
 *    models whose provider has usable credentials).
 */
import { t } from '../i18n';
import type { MessageKey } from '../i18n/messages';

export interface PiCommandOption {
  /** The token typed after the command. */
  value: string;
  /** Primary text on the row. */
  label: string;
  /** Secondary text: the provider for a model, the meaning of a level. */
  detail?: string;
}

export type PiOptionSource = 'models' | 'thinking';

/** The levels pi maps to its reasoning budget, weakest first. */
const THINKING_LEVELS: ReadonlyArray<{ level: string; detailKey: MessageKey }> = [
  { level: 'off', detailKey: 'commands.thinking.off' },
  { level: 'minimal', detailKey: 'commands.thinking.minimal' },
  { level: 'low', detailKey: 'commands.thinking.low' },
  { level: 'medium', detailKey: 'commands.thinking.medium' },
  { level: 'high', detailKey: 'commands.thinking.high' },
  { level: 'xhigh', detailKey: 'commands.thinking.xhigh' },
  { level: 'max', detailKey: 'commands.thinking.max' },
];

/**
 * Which picker a command needs, or null for a command whose argument is free
 * text (`/name`, `/export`). Keyed on the literal token the catalog stores.
 */
export function optionSourceFor(command: string): PiOptionSource | null {
  const token = command.trim().toLowerCase();
  if (token === '/model') return 'models';
  if (token === '/thinking') return 'thinking';
  return null;
}

/** The thinking levels, in pi's own order, described in the active language. */
export function thinkingOptions(): PiCommandOption[] {
  return THINKING_LEVELS.map(({ level, detailKey }) => ({
    value: level,
    label: level,
    detail: t(detailKey),
  }));
}

/** `ESC[` … `m` colour runs, which `--list-models` may add when it detects a TTY. */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * A model token: pi's ids are `provider/model`, a CLI shorthand (`sonnet`) or
 * a custom id from `models.json`. Anything with whitespace or a quote is a
 * table artefact, never a model.
 */
const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

/** Column headings a table-shaped listing may print before the rows. */
const MODEL_LIST_HEADERS = new Set(['provider', 'providers', 'model', 'models', 'id', 'available', 'name']);

/** A line that reports an empty or failed listing rather than a model. */
const MODEL_LIST_NOTICES = /no models|not available|error|failed|unauthori[sz]ed/i;

/**
 * A bullet a listing may prefix. Deliberately a closed set: stripping every
 * leading non-alphanumeric would turn a malformed `"quoted` fragment into a
 * plausible-looking model id.
 */
const MODEL_LIST_BULLET = /^[•*·>»\u2013\u2014\s-]+/u;

/**
 * Parse `pi --list-models` output into rows. Deliberately tolerant: pi prints
 * a plain list, but a version may add a header row or a provider column, and a
 * credentials problem prints a sentence instead of models. Every line is
 * reduced to its first token, and a token that cannot be a model id is
 * dropped, so a misread line becomes a missing row instead of a broken
 * `/model` argument.
 */
export function parsePiModelList(stdout: string): PiCommandOption[] {
  const options: PiCommandOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.replace(ANSI_PATTERN, '').split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line === '') continue;
    if (MODEL_LIST_NOTICES.test(line)) continue;
    // Strip a bullet a listing may prefix (it is its own whitespace-delimited
    // token), then take the first column and reject anything that cannot be a
    // model id.
    const model = line.replace(MODEL_LIST_BULLET, '').split(/\s+/u)[0] ?? '';
    if (!MODEL_TOKEN.test(model)) continue;
    if (MODEL_LIST_HEADERS.has(model.toLowerCase())) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const slash = model.indexOf('/');
    options.push({
      value: model,
      label: model,
      ...(slash > 0 ? { detail: model.slice(0, slash) } : {}),
    });
  }
  return options;
}

/** The draft a pick leaves behind: the command plus the chosen token. */
export function optionInsertion(command: string, option: PiCommandOption): string {
  return `${command.trim()} ${option.value}`;
}
