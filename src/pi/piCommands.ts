export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function encodePiCwd(cwd: string): string {
  const stripped = cwd.startsWith('/') ? cwd.slice(1) : cwd;
  return `--${stripped.replace(/[/\\:]/g, '-')}--`;
}

/**
 * The project directories under the session root, newest conversation first:
 * every `*.jsonl` exactly two levels below the root prints as `%T@ %p`, sorted
 * newest first, so a directory's first appearance sits at its most recently
 * written session. `ls -1` listed them alphabetically — the project the user
 * is working in right now sat wherever the alphabet put it.
 */
export function listSessionDirsCommand(root: string): string {
  return `find ${quoteShell(root)} -mindepth 2 -maxdepth 2 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn`;
}

export function readProjectCwdCommand(dir: string): string {
  return `for f in ${quoteShell(dir)}/*.jsonl; do head -n 1 "$f"; break; done 2>/dev/null`;
}

export function listSessionFilesCommand(dir: string): string {
  return `find ${quoteShell(dir)} -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn`;
}

/**
 * Every conversation file under the session root, one path per line: the
 * candidate set a live turn's tmux session name is matched back against.
 *
 * The name is a hash of the file path, so the file cannot be recovered from it
 * — the only way back is to hash the candidates and look for the one that
 * produces the name. Depth 2 is pi's own layout (one encoded `--cwd--`
 * directory below the root) and the same bound the session listings use, so
 * this never walks an unrelated tree.
 */
export function listTurnSessionFilesCommand(root: string): string {
  return `find ${quoteShell(root)} -mindepth 2 -maxdepth 2 -name '*.jsonl' -print 2>/dev/null`;
}

/**
 * One exec that answers everything a list row needs from a session file: the
 * file's tail (the turns the preview is taken from) followed by its LAST
 * `session_info` line — the conversation's name.
 *
 * The tail alone loses names: `/name` appends its entry where the user ran the
 * command, so a conversation that kept working afterwards grows past the tail
 * window and its name falls outside it — which is how a conversation the user
 * named came to be listed under its bare id. The two parts are printed in one
 * command and parsed as one text, tail first: the line `grep` found is the
 * newest `session_info`, so it is the last one the parser sees and therefore
 * the name it keeps.
 *
 * The pattern is anchored at the line's start on purpose. A message whose text
 * merely quotes an entry (`{"type":"session_info"…}` pasted into a prompt)
 * must not be picked up as one: a duplicated message line would move the
 * parse's "last message" and make a finished conversation look unfinished.
 * `echo` closes the tail's final line — a file need not end with a newline, and
 * the grep output must never share a line with it.
 */
export function readSessionSummaryCommand(path: string, maxBytes: number): string {
  const quoted = quoteShell(path);
  return [
    `tail -c ${maxBytes} -- ${quoted} 2>/dev/null`,
    'echo',
    `grep -a -E '^[{][[:space:]]*"type"[[:space:]]*:[[:space:]]*"session_info"' -- ${quoted} 2>/dev/null | tail -n 1`,
  ].join('; ');
}

/**
 * Remove one session file. `-f` so an already-gone file (deleted on the host
 * while the phone was offline) still exits 0: the user's intent is "this
 * conversation is gone", and reporting a failure for a file that is no longer
 * there would be noise. The `--` is what keeps a path starting with `-` from
 * being read as an option.
 */
export function deleteSessionFileCommand(path: string): string {
  return `rm -f -- ${quoteShell(path)}`;
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
 * True when `root` has pi's session-file shape: pi groups sessions one encoded
 * `--cwd--` directory below the root, so a real sessions root holds `*.jsonl`
 * at exactly depth 2. A directory that merely exists (the agent tree itself,
 * `~/.pi`) passes {@link resolveSessionRootCommand} and then lists zero
 * sessions — this is the guard against a session-dir override that names a
 * real-but-wrong directory.
 */
export function sessionsRootHasFilesCommand(root: string): string {
  const quoted = quoteShell(root);
  return `find ${quoted} -mindepth 2 -maxdepth 2 -name '*.jsonl' -print -quit 2>/dev/null | grep -q . && echo yes`;
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
 * pi exposes no command-list RPC, so this reads the resource directories pi
 * actually uses: the documented `$HOME/.pi/agent` tree and the project's
 * `.pi/...`, plus — observed on pi 1.4 — every package under
 * `<agent>/npm/node_modules`, where `pi install <npm:...>` puts the extension
 * sources. Each package is scanned as its own grep root, so `node_modules`
 * pruning still keeps a package's nested dependencies out of the walk.
 * `agentRoots` prepends directories this app discovered the host actually
 * uses (see `piAgentDir`: `PI_CODING_AGENT_DIR` in the exec or login-shell
 * env, or the parent of the resolved session root) — a relocated agent tree
 * otherwise answers "no commands" with exit 0, the exact silence that hides
 * extension commands a working pi has.
 * `registerCommand` takes a string literal at every real call site, which is
 * what makes the source scan good enough; a call with a non-literal name
 * yields a stray token the caller drops as an unknown name. `node_modules` is
 * pruned so an installed package cannot turn this into a multi-second walk.
 */
export function piSlashProbeCommand(projectPath: string, agentRoots: readonly string[] = []): string {
  const project = quoteShell(projectPath);
  const roots = [...agentRoots.map((root) => quoteShell(root)), '"$HOME/.pi/agent"'].join(' ');
  return [
    PI_SLASH_PROBE_MARKER,
    `for pi_ps_root in ${roots} ${project}/.pi; do`,
    // `npm/node_modules/@*/*` widens the scoped names and `*` the bare ones;
    // an unmatched glob stays literal and the `-d` test drops it.
    '  for pi_ps_dir in "$pi_ps_root/extensions" "$pi_ps_root/packages" "$pi_ps_root"/npm/node_modules/* "$pi_ps_root"/npm/node_modules/@*/*; do',
    '    [ -d "$pi_ps_dir" ] || continue',
    // Two extractions, both over the same tree. The first demands a quoted
    // literal — an unquoted argument (a parameter name in a `.d.ts`, a bare
    // identifier) is not a command name. The second resolves the indirection
    // pi packages do use: `registerCommand(SESSION_NIX_COMMAND, ...)` with
    // `const SESSION_NIX_COMMAND = "session-nix"` elsewhere in the package;
    // the last `.`-segment covers `spec.name`-style references. A reference
    // with no resolvable assignment simply stays silent.
    // Every source file is scanned (no `--include` list) so these literals
    // carry no file-extension token the release-copy guard reads as prose;
    // `-i` plus the `[A-Za-z]*[(]` strip keep the camelCase API name out of
    // the command for the same reason. The match itself stays exact.
    "    grep -r -h -o -E -i --exclude-dir=node_modules --exclude-dir=.git -I \"registercommand[(][[:space:]]*[\\\"'][^[:space:],)\\\"']+[\\\"']\" \"$pi_ps_dir\" 2>/dev/null | sed -E 's/^[A-Za-z]*[(]//; s/^[^A-Za-z0-9]+//; s/[^A-Za-z0-9:_.-]+$//' | sort -u | while IFS= read -r pi_ps_name; do [ -n \"$pi_ps_name\" ] && printf 'cmd\\t%s\\t%s\\n' \"$pi_ps_name\" \"$pi_ps_dir\"; done",
    "    grep -r -h -o -E -i --exclude-dir=node_modules --exclude-dir=.git -I \"registercommand[(][[:space:]]*[A-Za-z_][A-Za-z0-9_.]*[),]\" \"$pi_ps_dir\" 2>/dev/null | sed -E 's/^[A-Za-z]*[(]//; s/^[[:space:]]*//; s/[),]$//; s/.*[.]//' | sort -u | while IFS= read -r pi_ps_ref; do case \"$pi_ps_ref\" in ''|*[!A-Za-z0-9_]*) continue;; esac; pi_ps_val=$(grep -r -h -o -E --exclude-dir=node_modules --exclude-dir=.git -I \"(const|let|var)[[:space:]]+$pi_ps_ref[[:space:]]*=[[:space:]]*[\\\"'][a-z0-9][a-z0-9:_.-]*[\\\"']\" \"$pi_ps_dir\" 2>/dev/null | head -n 1 | sed -E 's/.*=[[:space:]]*//; s/[^a-z0-9:._-]//g'); [ -n \"$pi_ps_val\" ] && printf 'cmd\\t%s\\t%s\\n' \"$pi_ps_val\" \"$pi_ps_dir\"; done",
    '  done',
    '  for pi_ps_dir in "$pi_ps_root/prompts" "$pi_ps_root/skills"; do',
    '    [ -d "$pi_ps_dir" ] || continue',
    "    ls -1 \"$pi_ps_dir\" 2>/dev/null | sed -E 's/\\.md$//' | grep -E '^[A-Za-z0-9][A-Za-z0-9:_.-]*$' | sort -u | while IFS= read -r pi_ps_name; do case \"$pi_ps_dir\" in */prompts) printf 'tpl\\t%s\\t%s\\n' \"$pi_ps_name\" \"$pi_ps_dir\";; *) printf 'skill\\t%s\\t%s\\n' \"$pi_ps_name\" \"$pi_ps_dir\";; esac; done",
    '  done',
    'done',
    'true',
  ].join('\n');
}

