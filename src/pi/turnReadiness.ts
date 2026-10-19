export const PI_PROMPT_MARKER = '\u203a';

const MAX_TRACKED_TEXT = 8192;

function cleanConsoleText(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const overwrite = line.lastIndexOf('\r');
      return overwrite === -1 ? line : line.slice(overwrite + 1);
    })
    .join('\n');
}

export function createConsoleTracker(): { push(chunk: string): void; text(): string } {
  let retained = '';
  return {
    push(chunk: string): void {
      retained = (retained + chunk).slice(-MAX_TRACKED_TEXT);
    },
    text(): string {
      return cleanConsoleText(retained);
    },
  };
}

export function countPrompts(consoleText: string): number {
  let count = 0;
  let index = consoleText.indexOf(PI_PROMPT_MARKER);
  while (index !== -1) {
    count += 1;
    index = consoleText.indexOf(PI_PROMPT_MARKER, index + PI_PROMPT_MARKER.length);
  }
  return count;
}

/** The first prompt is Pi's banner/readline prompt, so readiness is "at least one". */
export function isPiReady(consoleText: string): boolean {
  return countPrompts(consoleText) >= 1;
}
