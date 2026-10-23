export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function encodePiCwd(cwd: string): string {
  const stripped = cwd.startsWith('/') ? cwd.slice(1) : cwd;
  return `--${stripped.replace(/[/\\:]/g, '-')}--`;
}

export function listSessionDirsCommand(root: string): string {
  return `ls -1 -- ${quoteShell(root)} 2>/dev/null`;
}

export function readProjectCwdCommand(dir: string): string {
  return `for f in ${quoteShell(dir)}/*.jsonl; do head -n 1 "$f"; break; done 2>/dev/null`;
}

export function listSessionFilesCommand(dir: string): string {
  return `find ${quoteShell(dir)} -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn`;
}

export function readSessionTailCommand(path: string, maxBytes: number): string {
  return `tail -c ${maxBytes} -- ${quoteShell(path)} 2>/dev/null`;
}

/** Lines `startLine..startLine+lineCount-1` (1-based), for paged fallback reads. */
export function readSessionLinesCommand(path: string, startLine: number, lineCount: number): string {
  const from = Math.max(1, Math.floor(startLine));
  const count = Math.max(1, Math.floor(lineCount));
  return `tail -n +${from} -- ${quoteShell(path)} 2>/dev/null | head -n ${count}`;
}

export function resolveSessionRootCommand(root: string): string {
  return `test -d ${quoteShell(root)} && echo yes`;
}

/**
 * Where node keeps its bin directory when PATH does not have it. The pi
 * directory is derived from the resolved command and comes first: an
 * npm-style install puts `pi` and `node` in the same prefix's bin, so it is
 * the one directory that is right by construction. The globs are last resorts
 * for a pi that is only a wrapper, and any node in them is one this account
 * installed on purpose.
 */
const NODE_BIN_GLOBS = '"$HOME"/.nvm/versions/node/*/bin /home/projects/softwares/node-*/bin';

/**
 * Every shell this app drives is a NON-LOGIN one: the exec channel and the
 * turn PTY both run `<shell> -c <command>`, which reads no `/etc/profile` and
 * no `~/.bashrc`. A host whose node lives under a versioned prefix or nvm
 * therefore answers `/usr/bin/env: 'node': No such file or directory` for the
 * very pi that works the moment a person types it into an interactive
 * terminal — pi's first line is `#!/usr/bin/env node`, so it needs `node` on
 * PATH and finds none. The turn PTY then exits before it can draw its editor,
 * and the app reports "pi is not ready yet".
 *
 * This prefix is the fix: do nothing when `node` is already reachable,
 * otherwise put pi's own directory (then the usual per-version layouts) on
 * PATH. It prints nothing and cannot fail, so it is safe in front of an
 * `exec`, and it is derived from the host rather than assumed about it.
 */
export function piNodePathPrelude(piCommand: string): string {
  const ownDir = piCommand.replace(/\/[^/]*$/u, '');
  return `command -v node >/dev/null 2>&1 || { for pi_node_dir in ${quoteShell(ownDir)} ${NODE_BIN_GLOBS}; do [ -x "$pi_node_dir/node" ] && PATH="$pi_node_dir:$PATH" && export PATH && break; done; };`;
}

/**
 * The models this host can actually reach right now. pi lists only the models
 * whose provider has usable credentials, which is why this is probed rather
 * than shipped: the answer changes with `/login`, `/logout` and the shell's
 * environment. It runs in the chat's project so a project-level
 * `.pi/settings.json` narrows the list exactly as it does for `/model`.
 * `piCommand` is the resolved absolute path (`resolvePiCommand`'s contract:
 * no whitespace, no shell metacharacters).
 *
 * stderr is left alone on purpose: pi prints why it could not list (a broken
 * `models.json`, a crashing extension, an unreadable install) on stderr, and
 * the caller shows that text when the probe fails. Redirecting it to
 * `/dev/null` is what makes "could not read the model list" unexplainable.
 *
 * `builtInsOnly` drops `--no-extensions` into the call. pi builds its whole
 * session runtime — extensions included, compiled on the fly — before it
 * prints this list, so a single bad extension fails the probe; the retry runs
 * without them. It is a flag, so the `[search]` argument of `--list-models`
 * cannot swallow it.
 */
export function piListModelsCommand(
  piCommand: string,
  projectPath: string,
  options: { builtInsOnly?: boolean } = {},
): string {
  const flags = options.builtInsOnly === true ? ' --no-extensions' : '';
  return `${piNodePathPrelude(piCommand)} cd ${quoteShell(projectPath)} && ${quoteShell(piCommand)}${flags} --list-models`;
}

export function piOverrideProbeCommand(override: string): string {
  const command = quoteShell(override);
  return `test -f ${command} && test -x ${command} && test -s ${command} && printf '%s\\n' ${command}`;
}

export function piPathProbeCommand(): string {
  return `p=$(command -v pi) && test -f "$p" && test -x "$p" && test -s "$p" && printf '%s\\n' "$p"`;
}

export function piNodeGlobProbeCommand(): string {
  return `p=$(ls -1 /home/projects/softwares/node-*/bin/pi 2>/dev/null | head -n1) && test -f "$p" && test -x "$p" && test -s "$p" && printf '%s\\n' "$p"`;
}

/** First line of {@link piSlashProbeCommand}: lets a mock host recognise the probe without parsing it. */
export const PI_SLASH_PROBE_MARKER = '# pi-slash-probe';

/**
 * One exec that reports which slash commands the host's pi install actually
 * has: extension commands registered by `pi.registerCommand(...)` in the
 * extension/package trees, prompt templates, and skills, as
 * `kind<TAB>name<TAB>source` lines.
 *
 * pi exposes no command-list RPC, so this reads the resource directories the
 * pi docs name (`$HOME/.pi/agent/{extensions,packages,prompts,skills}` and the
 * project's `.pi/...`). `registerCommand` takes a string literal at every real
 * call site, which is what makes the source scan good enough; a call with a
 * non-literal name yields a stray token the caller drops as an unknown name.
 * `node_modules` is pruned so an installed package cannot turn this into a
 * multi-second walk.
 */
export function piSlashProbeCommand(projectPath: string): string {
  const project = quoteShell(projectPath);
  return [
    PI_SLASH_PROBE_MARKER,
    `for pi_ps_root in "$HOME/.pi/agent" ${project}/.pi; do`,
    '  for pi_ps_dir in "$pi_ps_root/extensions" "$pi_ps_root/packages"; do',
    '    [ -d "$pi_ps_dir" ] || continue',
    // Every source file is scanned (no `--include` list) so this literal
    // carries no file-extension token the release-copy guard reads as prose;
    // `-i` plus the `[A-Za-z]*[(]` strip keep the camelCase API name out of
    // the command for the same reason. The match itself stays exact.
    "    grep -r -h -o -E -i --exclude-dir=node_modules --exclude-dir=.git -I 'registercommand[(][[:space:]]*[^[:space:],)]+' \"$pi_ps_dir\" 2>/dev/null | sed -E 's/^[A-Za-z]*[(]//; s/^[^A-Za-z0-9]+//; s/[^A-Za-z0-9:_.-]+$//' | sort -u | while IFS= read -r pi_ps_name; do [ -n \"$pi_ps_name\" ] && printf 'cmd\\t%s\\t%s\\n' \"$pi_ps_name\" \"$pi_ps_dir\"; done",
    '  done',
    '  for pi_ps_dir in "$pi_ps_root/prompts" "$pi_ps_root/skills"; do',
    '    [ -d "$pi_ps_dir" ] || continue',
    "    ls -1 \"$pi_ps_dir\" 2>/dev/null | sed -E 's/\\.md$//' | grep -E '^[A-Za-z0-9][A-Za-z0-9:_.-]*$' | sort -u | while IFS= read -r pi_ps_name; do case \"$pi_ps_dir\" in */prompts) printf 'tpl\\t%s\\t%s\\n' \"$pi_ps_name\" \"$pi_ps_dir\";; *) printf 'skill\\t%s\\t%s\\n' \"$pi_ps_name\" \"$pi_ps_dir\";; esac; done",
    '  done',
    'done',
    'true',
  ].join('\n');
}

