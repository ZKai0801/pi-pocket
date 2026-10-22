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
const MODEL_LIST_HEADERS = new Set([
  'provider', 'providers', 'model', 'models', 'id', 'available', 'name',
  'context', 'max-out', 'maxout', 'thinking', 'images',
]);

/** A line that reports an empty or failed listing rather than a model. */
const MODEL_LIST_NOTICES = /no models|not available|error|failed|unauthori[sz]ed|no models matching/i;

/**
 * A bullet a listing may prefix. Deliberately a closed set: stripping every
 * leading non-alphanumeric would turn a malformed `"quoted` fragment into a
 * plausible-looking model id.
 */
const MODEL_LIST_BULLET = /^[•*·>»\u2013\u2014\s-]+/u;

/**
 * The column separator of pi's table: `padEnd`-ed columns joined by two
 * spaces (and tabs in older shapes).
 */
const MODEL_LIST_COLUMNS = /\t+| {2,}/u;

/** A provider column: an id, never a `provider/model` pair. */
const PROVIDER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/;

/**
 * Parse `pi --list-models` output into rows.
 *
 * The real shape is a table whose first column is the provider and whose
 * second is the model id:
 *
 *     provider   model                   context  max-out  thinking  images
 *     anthropic  claude-sonnet-4-5       200K     64K      yes       yes
 *
 * `/model` takes `provider/model`, so that pair is the inserted token and the
 * provider stays as the row's detail. Three shapes are tolerated on top of it:
 * a single-column listing of full `provider/model` ids, a tab-separated row,
 * and a lone bare id (`sonnet`). The column split is what decides: a first
 * column containing a `/` is already a complete id (`provider` ids never carry
 * one), otherwise the second column is the model and the first is its
 * provider. Every candidate still has to survive {@link MODEL_TOKEN}, so a
 * misread line becomes a missing row instead of a broken `/model` argument.
 */
export function parsePiModelList(stdout: string): PiCommandOption[] {
  const options: PiCommandOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.replace(ANSI_PATTERN, '').split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line === '') continue;
    if (MODEL_LIST_NOTICES.test(line)) continue;
    const columns = line
      .split(MODEL_LIST_COLUMNS)
      .map((column) => column.replace(MODEL_LIST_BULLET, '').trim())
      .filter((column) => column !== '');
    const [first, second] = columns;
    if (first === undefined) continue;
    if (MODEL_LIST_HEADERS.has(first.toLowerCase())) continue;

    // A first column carrying a `/` is already a complete id: provider ids
    // never contain one, so this row has no separate provider column.
    const option = columns.length >= 2 && second !== undefined
      && !first.includes('/') && PROVIDER_TOKEN.test(first)
      ? pairOption(first, second)
      : bareOption(first);
    if (option === null) continue;
    const key = option.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  return options;
}

/**
 * True when `pi --list-models` answered "I have nothing" rather than failing:
 * it prints `No models available. Use /login …` and exits 0 when no provider
 * has usable credentials. That is an empty list for the picker, not a broken
 * probe — the difference is the only thing that tells a user which of the two
 * problems they have.
 */
export function piReportsNoModels(stdout: string): boolean {
  return /no models available/i.test(stdout);
}

/** What one `pi --list-models` run told us: rows, or the reason it gave none. */
export interface PiModelListOutcome {
  models: PiCommandOption[];
  /** The reason to show, or null when the run answered (even with no rows). */
  failure: string | null;
}

/** A reason line is a headline, not a log: one line, bounded. */
const FAILURE_LINE_MAX = 200;

function firstLine(text: string): string {
  return (text.trim().split('\n')[0] ?? '').trim().slice(0, FAILURE_LINE_MAX);
}

/**
 * The line worth showing from a failed run. pi writes `Warning: …` before it
 * does its work, and a warning is followed by indented context and only then
 * by the failure, so the first non-warning line is not always the answer:
 * prefer a line that reads like a failure, then any line that is not a
 * warning, then whatever was printed.
 */
function reasonLine(stdout: string, stderr: string): string {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const notWarning = lines.filter((line) => !/^warning:/i.test(line));
  const meaningful = notWarning.find((line) => FAILURE_WORDS.test(line))
    ?? notWarning[0]
    ?? lines[0];
  const detail = (meaningful ?? '').slice(0, FAILURE_LINE_MAX);
  return detail === '' ? firstLine(stdout) : detail;
}

/** Wording that marks a line as the failure rather than as its context. */
const FAILURE_WORDS = /error|fatal|cannot|can't|failed|not found|permission denied|enoent|eacces/i;

/**
 * Judge one `pi --list-models` run. Three answers exist and only one of them
 * is an error the user can act on, so they are separated here rather than in
 * the component: a table (rows), "no provider has credentials" (an empty list
 * that is NOT a failure), and a run that failed (the reason it printed).
 *
 * The third case is why this exists. pi's reason goes to stderr, and an app
 * that discards stderr turns every possible cause — a broken extension, an
 * unreadable install, a bad `models.json`, a `cd` that failed — into the same
 * "could not read the model list".
 */
export function piModelListOutcome(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): PiModelListOutcome {
  const models = parsePiModelList(stdout);
  if (models.length > 0) return { models, failure: null };
  if (exitCode === 0) {
    if (piReportsNoModels(stdout)) return { models: [], failure: null };
    // Exit 0, no rows, no "no models" notice: the listing still answered
    // something, so its shape is what changed. Say so instead of "none".
    const said = firstLine(stdout);
    return {
      models: [],
      failure: said === '' ? 'pi --list-models printed nothing' : said,
    };
  }
  const detail = reasonLine(stdout, stderr);
  return {
    models: [],
    failure: detail === '' ? `pi --list-models exited ${exitCode ?? 'unknown'}` : detail,
  };
}

/** `provider  model` from a table row, with the provider as the row detail. */
function pairOption(provider: string, model: string): PiCommandOption | null {
  if (!MODEL_TOKEN.test(model)) return null;
  return { value: `${provider}/${model}`, label: model, detail: provider };
}

/**
 * A row with no separate provider column. Requiring the id to be one token is
 * what keeps prose out: pi's "No models available. Use /login to log in …"
 * guidance is one line of single-spaced words, so nothing in it is a token.
 */
function bareOption(token: string): PiCommandOption | null {
  if (!MODEL_TOKEN.test(token)) return null;
  const slash = token.indexOf('/');
  return {
    value: token,
    label: slash > 0 ? token.slice(slash + 1) : token,
    ...(slash > 0 ? { detail: token.slice(0, slash) } : {}),
  };
}

/** The draft a pick leaves behind: the command plus the chosen token. */
export function optionInsertion(command: string, option: PiCommandOption): string {
  return `${command.trim()} ${option.value}`;
}
