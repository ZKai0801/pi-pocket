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
 * for a pi that is only a wrapper.
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
