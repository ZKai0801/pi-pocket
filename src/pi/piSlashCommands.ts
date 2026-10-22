/**
 * The pi slash-command catalog behind the chat composer's “+” sheet.
 *
 * Two sources, in this order:
 *
 * 1. `PI_BUILTIN_COMMANDS` — the app-shipped list of the commands pi documents
 *    for an interactive session. Curated, following the rule the shared catalog
 *    states in pocketshell-core `src/agentCommands.ts`: a command the agent does
 *    not have is simply absent, never stubbed. `/quit` is deliberately absent
 *    because it would end the very process this chat drives.
 * 2. `parsePiSlashProbe` — what the host itself has installed: extension
 *    commands (`pi.registerCommand(...)`), prompt templates and skills.
 *    Discovery is best-effort BY DESIGN — pi exposes no command-list RPC, so
 *    the probe reads the resource directories and a failed probe simply leaves
 *    the built-ins in place.
 *
 * Nothing here runs anything: a pick is INSERTED into the composer's draft
 * (spec §42, “contextual command insertion, not a second agent UI”), so the
 * user can add an argument and still has to tap 发送.
 */
import type { PiTransport } from './piRepository';
import { piSlashProbeCommand } from './piCommands';
import { t } from '../i18n';
import type { MessageKey } from '../i18n/messages';

/** Sheet sections, in render order. */
export type PiCommandGroup =
  | 'session'
  | 'model'
  | 'share'
  | 'runtime'
  | 'extension'
  | 'template'
  | 'skill';

export const PI_COMMAND_GROUPS: readonly PiCommandGroup[] = [
  'session',
  'model',
  'share',
  'runtime',
  'extension',
  'template',
  'skill',
];

/** The i18n key for a section's heading. */
export function piCommandGroupKey(group: PiCommandGroup): MessageKey {
  return `commands.group.${group}` as MessageKey;
}

export interface PiSlashCommand {
  /** Literal text typed into pi, leading `/` included. */
  command: string;
  group: PiCommandGroup;
  /** Built-ins only: the one-line description's copy key. */
  descriptionKey?: MessageKey;
  /** The inline argument's placeholder; a pick keeps one trailing space for it. */
  argument?: string;
  /**
   * The bare form opens a pi TUI surface (a picker, the tree view, a login
   * flow) that this chat cannot render, so the row says 终端/“Terminal”.
   */
  tuiOnly?: boolean;
  /** Host-discovered commands only: the directory the command came from. */
  source?: string;
}

/**
 * pi's documented in-session commands that make sense as a typed line here.
 * Text form only: any command whose ONLY form is a full-screen picker is
 * marked `tuiOnly` rather than hidden, because seeing pi's real vocabulary is
 * the point of the sheet — the tag tells the user where it belongs.
 */
export const PI_BUILTIN_COMMANDS: readonly PiSlashCommand[] = [
  {
    command: '/compact',
    group: 'session',
    descriptionKey: 'commands.desc.compact',
    argument: 'instructions',
  },
  { command: '/session', group: 'session', descriptionKey: 'commands.desc.session' },
  { command: '/name', group: 'session', descriptionKey: 'commands.desc.name', argument: 'name' },
  { command: '/copy', group: 'session', descriptionKey: 'commands.desc.copy' },
  { command: '/new', group: 'session', descriptionKey: 'commands.desc.new', tuiOnly: true },
  { command: '/resume', group: 'session', descriptionKey: 'commands.desc.resume', tuiOnly: true },
  { command: '/tree', group: 'session', descriptionKey: 'commands.desc.tree', tuiOnly: true },
  { command: '/fork', group: 'session', descriptionKey: 'commands.desc.fork', tuiOnly: true },
  { command: '/clone', group: 'session', descriptionKey: 'commands.desc.clone', tuiOnly: true },
  {
    command: '/import',
    group: 'session',
    descriptionKey: 'commands.desc.import',
    argument: 'path',
    tuiOnly: true,
  },
  {
    command: '/model',
    group: 'model',
    descriptionKey: 'commands.desc.model',
    argument: 'provider/model',
  },
  {
    command: '/thinking',
    group: 'model',
    descriptionKey: 'commands.desc.thinking',
    argument: 'level',
  },
  { command: '/scoped-models', group: 'model', descriptionKey: 'commands.desc.scopedModels', tuiOnly: true },
  {
    command: '/login',
    group: 'model',
    descriptionKey: 'commands.desc.login',
    argument: 'provider',
    tuiOnly: true,
  },
  { command: '/logout', group: 'model', descriptionKey: 'commands.desc.logout' },
  { command: '/settings', group: 'model', descriptionKey: 'commands.desc.settings', tuiOnly: true },
  {
    command: '/export',
    group: 'share',
    descriptionKey: 'commands.desc.export',
    argument: 'path',
  },
  { command: '/share', group: 'share', descriptionKey: 'commands.desc.share' },
  { command: '/bug', group: 'share', descriptionKey: 'commands.desc.bug', argument: 'description' },
  { command: '/reload', group: 'runtime', descriptionKey: 'commands.desc.reload' },
  { command: '/skill:', group: 'runtime', descriptionKey: 'commands.desc.skill', argument: 'name' },
  { command: '/hotkeys', group: 'runtime', descriptionKey: 'commands.desc.hotkeys', tuiOnly: true },
  { command: '/trust', group: 'runtime', descriptionKey: 'commands.desc.trust', tuiOnly: true },
  { command: '/changelog', group: 'runtime', descriptionKey: 'commands.desc.changelog', tuiOnly: true },
];

/** The row's one-line explanation, in the active language. */
export function commandDescription(command: PiSlashCommand): string {
  if (command.descriptionKey !== undefined) return t(command.descriptionKey);
  if (command.source !== undefined && command.source !== '') {
    return t('commands.source', { source: command.source });
  }
  return '';
}

/**
 * The text a pick puts in the draft. An argument keeps one trailing space so
 * the caret lands ready to type it; the `/skill:` colon form takes the name
 * with no separator.
 */
export function insertionFor(command: PiSlashCommand): string {
  if (command.argument === undefined) return command.command;
  return command.command.endsWith(':') ? command.command : `${command.command} `;
}

/** Case-insensitive substring match over the token, the description and the source. */
export function filterPiCommands(
  commands: readonly PiSlashCommand[],
  query: string,
): PiSlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...commands];
  return commands.filter((command) => (
    command.command.toLowerCase().includes(needle)
    || commandDescription(command).toLowerCase().includes(needle)
    || (command.source ?? '').toLowerCase().includes(needle)
  ));
}

/**
 * Built-ins first, then what the host added. A host entry never replaces a
 * built-in row: the app-shipped list is the one this build was tested against,
 * and a stale or shadowing extension must not rewrite it.
 */
export function mergePiCommands(discovered: readonly PiSlashCommand[]): PiSlashCommand[] {
  const taken = new Set(PI_BUILTIN_COMMANDS.map((command) => command.command.toLowerCase()));
  const extra: PiSlashCommand[] = [];
  for (const command of discovered) {
    const key = command.command.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    extra.push(command);
  }
  return [...PI_BUILTIN_COMMANDS, ...extra];
}

/** Commands grouped for render, empty sections dropped, in {@link PI_COMMAND_GROUPS} order. */
export function groupPiCommands(
  commands: readonly PiSlashCommand[],
): Array<{ group: PiCommandGroup; commands: PiSlashCommand[] }> {
  const sections: Array<{ group: PiCommandGroup; commands: PiSlashCommand[] }> = [];
  for (const group of PI_COMMAND_GROUPS) {
    const members = commands.filter((command) => command.group === group);
    if (members.length > 0) sections.push({ group, commands: members });
  }
  return sections;
}

/** Skill entries that are files rather than skill names; never offered as `/skill:`. */
const SKILL_FILE_NAMES = new Set(['skill', 'readme', 'index']);

/** A slash-command token: pi splits on whitespace, so no spaces or quotes here. */
const COMMAND_TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;

/** The last two path segments, so a row can say `agent/extensions`. */
function shortSource(source: string): string {
  const parts = source.split('/').filter((part) => part !== '');
  return parts.slice(-2).join('/');
}

/**
 * Parse the probe's `kind<TAB>name<TAB>source` lines. Unknown kinds, malformed
 * names and skill index files are dropped; repeats keep the first occurrence,
 * so the host's own ordering (extensions, then prompts, then skills) wins.
 */
export function parsePiSlashProbe(stdout: string): PiSlashCommand[] {
  const found: PiSlashCommand[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || line.startsWith('#')) continue;
    const [kind, name, source = ''] = line.split('\t');
    if (kind === undefined || name === undefined) continue;
    const token = name.trim();
    if (!COMMAND_TOKEN.test(token)) continue;
    if (kind === 'skill' && SKILL_FILE_NAMES.has(token.toLowerCase())) continue;

    let command: PiSlashCommand;
    if (kind === 'cmd') {
      command = { command: `/${token}`, group: 'extension', source: shortSource(source) };
    } else if (kind === 'tpl') {
      command = { command: `/${token}`, group: 'template', source: shortSource(source) };
    } else if (kind === 'skill') {
      command = { command: `/skill:${token}`, group: 'skill', source: shortSource(source) };
    } else {
      continue;
    }
    if (seen.has(command.command.toLowerCase())) continue;
    seen.add(command.command.toLowerCase());
    found.push(command);
  }
  return found;
}

/** Same budget as the repository's other probes: one exec, never a chat-blocking wait. */
const PROBE_TIMEOUT_MS = 15_000;

export interface PiCommandDiscovery {
  commands: PiSlashCommand[];
  /** Why the host's own commands are missing, or null when the probe answered. */
  error: string | null;
}

/**
 * Ask the live host which extension commands, templates and skills it has.
 * Never throws: the caller merges whatever comes back with the built-ins, and
 * `error` only drives the sheet's “built-ins only” notice.
 */
export async function discoverPiCommands(
  transport: PiTransport,
  projectPath: string,
): Promise<PiCommandDiscovery> {
  try {
    const result = await transport.exec(piSlashProbeCommand(projectPath), PROBE_TIMEOUT_MS);
    const commands = parsePiSlashProbe(result.stdout);
    if (result.exitCode !== 0 && commands.length === 0) {
      const detail = result.stderr.trim();
      return {
        commands: [],
        error: detail === '' ? `the probe exited ${result.exitCode}` : detail,
      };
    }
    return { commands, error: null };
  } catch (error) {
    return {
      commands: [],
      error: error instanceof Error && error.message !== '' ? error.message : String(error),
    };
  }
}
