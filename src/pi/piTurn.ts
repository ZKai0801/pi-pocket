import { piNodePathPrelude, quoteShell } from './piCommands';

export function buildPiOpenCommand(
  piCommand: string,
  projectPath: string,
  sessionFile?: string,
): string {
  if (/[\r\n]/.test(piCommand)) {
    throw new Error('A newline is not allowed in the pi command');
  }
  const session = sessionFile === undefined ? '' : ` --session ${quoteShell(sessionFile)}`;
  // Same non-login shell as the exec channel, so pi needs the same PATH
  // bootstrap here; see piNodePathPrelude. It prints nothing, and `exec`
  // replaces the shell after it.
  return `${piNodePathPrelude(piCommand)} cd ${quoteShell(projectPath)} && exec ${quoteShell(piCommand)}${session}`;
}

/** A multi-line message is delivered as one line of terminal input. */
export function toTurnLine(message: string): string {
  return message.replace(/[\r\n]+/g, ' ').trim();
}
