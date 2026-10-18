# PocketShell WeChat-UI Rebuild — Plan 1: Foundation + Pi data layer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the checkout build again, and add a pure, fully unit-tested
TypeScript layer that turns a server's Pi session files into projects, session
lists and chat turns — no UI, no device, no native code.

**Architecture:** `src/pi/` holds pure functions over strings/JSON plus one
repository class that talks to the server through an injected transport. The
transport is the only I/O seam, so every decision (parsing, grouping, path
encoding, command building) is tested in Node against canned input and the
real, verified session format. Remote reads reuse the existing SSH
`exec`/SFTP capability; nothing else in the app is touched.

**Tech Stack:** TypeScript, Vitest, existing `@pocketshell/core` and native
`sshCapability`. Node ≥ 20; pnpm 12.5.1.

**Spec:** `docs/superpowers/specs/2026-10-19-wechat-ui-pi-design.md` (§5, §7.4, §9)

## Global Constraints

- **Pi only.** No Claude Code / Codex / OpenCode / Grok parsing.
- **Chat keeps only body text.** From `message` entries keep `user` text and
  `assistant` `text` blocks; drop `thinking`, `toolCall`, `toolResult`,
  `system`, `bashExecution`, `compaction`, and all `custom` entries.
- **Session root is discovered, never hardcoded.** Per-host override wins,
  then `$PI_CODING_AGENT_SESSION_DIR`, then `$HOME/.pi-agent/sessions`, then
  `$HOME/.pi/agent/sessions`. On the target server the real root is
  `/home/projects/.pi-agent/sessions` and only the override finds it.
- **Verified format** (52-entry real session): entry `type`s `session`,
  `message`, `model_change`, `thinking_level_change`, `session_info`,
  `custom`; message roles `user`, `assistant`, `toolResult`; `user`/`assistant`
  `content` is an array of `{type:'text'|'thinking'|'toolCall', …}` blocks.
- **No new dependencies.** Use what `package.json` already pins.
- Node ≥ 20; the repo pins pnpm 12.5.1; `.nvmrc` pins the CI Node major.
- Dev host is Windows; POSIX `.sh` gates are not run in this plan (Vitest and
  `vue-tsc` are invoked directly).

## Review Focus

The spec implies these inputs but no task's happy path exercises them; each
gets a test in the task that owns the code, most likely first:

1. A JSONL file whose last line is a half-written append must still parse every
   complete line before it.
2. `content` observed as an array — but the format also allows a plain string;
   a string `content` must not be dropped.
3. An assistant turn with only `thinking`/`toolCall` and **no** `text` must add
   no assistant bubble, not an empty one.
4. A missing/empty session root, or a project dir with no `.jsonl`, must yield
   an empty list, not throw.
5. A transport failure (command non-zero, `pi` absent) must surface as a typed
   error, not a silently empty result.

---

### Task 1: Restore a buildable baseline

**Files:**
- Create: `.git/` (repository), `vendor/pocketshell-core/**` (submodule
  checkout), `node_modules/**` (installed). No source edits.

**Interfaces:**
- Consumes: nothing.
- Produces: a working `pnpm`, an initialized git repo with
  `vendor/pocketshell-core` recorded as the only gitlink, and green
  `node scripts/verify-js-source.mjs`, `pnpm typecheck`, `pnpm build:web`.

- [ ] **Step 1: Initialize the repository and commit the tree as-is**

The checkout has no git metadata, but the build reads the core pin from a
gitlink (`scripts/js-source-integrity.mjs:15,72`), so git must exist first.

```bash
git init
git add -A
git commit -m "chore: import pocketshell 0.6.0 tree"
```

- [ ] **Step 2: Add the pinned core submodule**

```bash
git submodule add https://github.com/PocketShell-io/pocketshell-core.git vendor/pocketshell-core
git add .gitmodules vendor/pocketshell-core
git commit -m "chore: pin pocketshell-core at main"
```

Expected: `vendor/pocketshell-core/src/index.ts` and
`vendor/pocketshell-core/packages/ui/src/styles.css` now exist.

- [ ] **Step 3: Install pnpm and dependencies**

```bash
corepack prepare pnpm@12.5.1 --activate
pnpm install --frozen-lockfile
```

- [ ] **Step 4: Verify the pin resolves**

Run: `node scripts/verify-js-source.mjs`
Expected: prints `pocketshell-core source (core + packages/ui): <sha>` and exits 0.

- [ ] **Step 5: Verify the untouched tree builds**

Run: `pnpm typecheck`
Expected: exit 0.
Run: `pnpm build:web`
Expected: exit 0, writes `dist/`.

If either fails, capture the exact core-vs-app mismatch errors as a new task —
this is the pin-drift risk from spec §5 — and stop.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: install dependencies against the core pin"
```

---

### Task 2: Parse a Pi session into turns

**Files:**
- Create: `src/pi/types.ts`
- Create: `src/pi/parsePiSession.ts`
- Test: `tests/unit/piParseSession.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PiTurn { role: 'user' | 'assistant'; text: string; timestampMs: number }`
  - `interface ParsedPiSession { version: number | null; id: string | null; cwd: string | null; name: string | null; turns: PiTurn[] }`
  - `function parsePiSession(jsonl: string): ParsedPiSession`
  - `function sessionPreview(parsed: ParsedPiSession): string | null`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/piParseSession.test.ts
import { describe, expect, it } from 'vitest';
import { parsePiSession, sessionPreview } from '../../src/pi/parsePiSession';

const header = '{"type":"session","version":3,"id":"s1","timestamp":"2026-10-18T01:52:19.726Z","cwd":"/home/kai"}';
const user = '{"type":"message","id":"u1","parentId":"s1","timestamp":"2026-10-18T01:52:32.023Z","message":{"role":"user","content":[{"type":"text","text":"look at ninfer"}],"timestamp":1792288352007}}';
const assistantThinking = '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-10-18T01:52:36.042Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"toolCall","id":"c1","name":"bash","arguments":{}}],"timestamp":1792288352099}}';
const toolResult = '{"type":"message","id":"t1","parentId":"a1","timestamp":"2026-10-18T01:52:36.358Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"lots of output"}],"isError":false}}';
const assistantText = '{"type":"message","id":"a2","parentId":"t1","timestamp":"2026-10-18T01:52:40.896Z","message":{"role":"assistant","content":[{"type":"text","text":"ninfer is busy."}],"timestamp":1792288356896}}';
const sessionInfo = '{"type":"session_info","id":"n1","parentId":"a2","timestamp":"2026-10-18T01:52:41.000Z","name":"ninfer-check"}';

describe('parsePiSession', () => {
  it('reads the header and session name', () => {
    const parsed = parsePiSession([header, user, assistantText, sessionInfo].join('\n'));
    expect(parsed.version).toBe(3);
    expect(parsed.cwd).toBe('/home/kai');
    expect(parsed.name).toBe('ninfer-check');
  });

  it('keeps user text and assistant text, and groups a turn', () => {
    const parsed = parsePiSession([header, user, assistantThinking, toolResult, assistantText].join('\n'));
    expect(parsed.turns).toEqual([
      { role: 'user', text: 'look at ninfer', timestampMs: 1792288352007 },
      { role: 'assistant', text: 'ninfer is busy.', timestampMs: 1792288356896 },
    ]);
  });

  it('drops a thinking/tool-only assistant turn', () => {
    const parsed = parsePiSession([header, user, assistantThinking, toolResult].join('\n'));
    expect(parsed.turns.map((t) => t.role)).toEqual(['user']);
  });

  it('accepts a plain-string content', () => {
    const stringUser = '{"type":"message","id":"u2","parentId":"s1","timestamp":"2026-10-18T01:53:00.000Z","message":{"role":"user","content":"hi","timestamp":1792288380000}}';
    const parsed = parsePiSession([header, stringUser].join('\n'));
    expect(parsed.turns).toEqual([{ role: 'user', text: 'hi', timestampMs: 1792288380000 }]);
  });

  it('ignores a truncated trailing line', () => {
    const parsed = parsePiSession([header, user, '{"type":"message","id":"x","par').join('\n'));
    expect(parsed.turns).toEqual([{ role: 'user', text: 'look at ninfer', timestampMs: 1792288352007 }]);
  });

  it('returns an empty result for empty input', () => {
    expect(parsePiSession('')).toEqual({ version: null, id: null, cwd: null, name: null, turns: [] });
  });

  it('previews the last assistant turn', () => {
    expect(sessionPreview(parsePiSession([header, user, assistantText].join('\n')))).toBe('ninfer is busy.');
    expect(sessionPreview(parsePiSession(''))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/piParseSession.test.ts`
Expected: FAIL — cannot resolve `../../src/pi/parsePiSession`.

- [ ] **Step 3: Implement the types and parser**

In `src/pi/types.ts` declare `PiTurn` and `ParsedPiSession` exactly as in
Interfaces. In `src/pi/parsePiSession.ts`, `split('\n')`, `JSON.parse` each
line inside `try/catch` (skip failures — covers Review Focus 1), then:

- header: from the `type === 'session'` entry, read `version` / `id` / `cwd`.
- name: overwrite on each `type === 'session_info'` entry that has a `name`.
- message text: `role` `user`/`assistant` only; `content` may be an array
  (join `b.text` for `b.type === 'text'`) or a string (use it directly — Review
  Focus 2); `timestampMs` from `message.timestamp` (fallback:
  `Date.parse(entry.timestamp)`).
- grouping: flush a pending assistant buffer when a `user` message arrives and
  at end; only push a turn whose trimmed text is non-empty (Review Focus 3).

`sessionPreview` returns the last `assistant` turn's `text` trimmed to 120
chars, else `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/piParseSession.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/types.ts src/pi/parsePiSession.ts tests/unit/piParseSession.test.ts
git commit -m "feat(pi): parse Pi session JSONL into chat turns"
```

---

### Task 3: Resolve the Pi session root

**Files:**
- Create: `src/pi/sessionRoot.ts`
- Test: `tests/unit/piSessionRoot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const PI_SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR'`
  - `function candidateSessionRoots(home: string, env: Record<string, string | undefined>, override?: string): string[]`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/piSessionRoot.test.ts
import { describe, expect, it } from 'vitest';
import { PI_SESSION_DIR_ENV, candidateSessionRoots } from '../../src/pi/sessionRoot';

describe('candidateSessionRoots', () => {
  it('puts the per-host override first', () => {
    const roots = candidateSessionRoots('/home/kai', {}, '/home/projects/.pi-agent/sessions');
    expect(roots[0]).toBe('/home/projects/.pi-agent/sessions');
  });

  it('uses the env var second', () => {
    const roots = candidateSessionRoots('/home/kai', { [PI_SESSION_DIR_ENV]: '/srv/pi/sessions' });
    expect(roots[0]).toBe('/srv/pi/sessions');
  });

  it('falls back to the two home-relative defaults in order', () => {
    expect(candidateSessionRoots('/home/kai', {})).toEqual([
      '/home/kai/.pi-agent/sessions',
      '/home/kai/.pi/agent/sessions',
    ]);
  });

  it('ignores a blank override', () => {
    expect(candidateSessionRoots('/home/kai', {}, '   ')[0]).toBe('/home/kai/.pi-agent/sessions');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/piSessionRoot.test.ts`
Expected: FAIL — cannot resolve `../../src/pi/sessionRoot`.

- [ ] **Step 3: Implement `candidateSessionRoots`**

Return, omitting blanks and de-duplicating while preserving order: the trimmed
`override`; `env[PI_SESSION_DIR_ENV]`; `${home}/.pi-agent/sessions`;
`${home}/.pi/agent/sessions`. Join with a single `/` and do not let `home` end
in a slash.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/piSessionRoot.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/sessionRoot.ts tests/unit/piSessionRoot.test.ts
git commit -m "feat(pi): resolve the Pi session root with a per-host override"
```

---

### Task 4: Build the remote commands

**Files:**
- Create: `src/pi/piCommands.ts`
- Test: `tests/unit/piCommands.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function quoteShell(value: string): string`
  - `function encodePiCwd(cwd: string): string`
  - `function listSessionDirsCommand(root: string): string`
  - `function readProjectCwdCommand(dir: string): string`
  - `function listSessionFilesCommand(dir: string): string`
  - `function readSessionTailCommand(path: string, maxBytes: number): string`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/piCommands.test.ts
import { describe, expect, it } from 'vitest';
import {
  encodePiCwd,
  listSessionDirsCommand,
  listSessionFilesCommand,
  quoteShell,
  readProjectCwdCommand,
  readSessionTailCommand,
} from '../../src/pi/piCommands';

describe('encodePiCwd', () => {
  it('matches the observed dir names', () => {
    expect(encodePiCwd('/home/kai')).toBe('--home-kai--');
    expect(encodePiCwd('/home/projects/auto_sci')).toBe('--home-projects-auto_sci--');
    expect(encodePiCwd('/home/kai/.pi')).toBe('--home-kai-.pi--');
  });
});

describe('quoteShell', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(quoteShell('/home/kai')).toBe("'/home/kai'");
    expect(quoteShell("a'b")).toBe("'a'\\''b'");
  });
});

describe('commands', () => {
  it('lists session dirs under the root', () => {
    expect(listSessionDirsCommand('/root')).toBe("ls -1 -- '/root' 2>/dev/null");
  });
  it('reads the first header line of any session file in a dir', () => {
    expect(readProjectCwdCommand("/r/--home-kai--"))
      .toBe('for f in \'/r/--home-kai--\'/*.jsonl; do head -n 1 "$f"; break; done 2>/dev/null');
  });
  it('lists session files newest first with mtime', () => {
    expect(listSessionFilesCommand('/r/--x--'))
      .toBe("find '/r/--x--' -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn");
  });
  it('tails a session file with a byte cap', () => {
    expect(readSessionTailCommand('/r/a.jsonl', 4096)).toBe("tail -c 4096 -- '/r/a.jsonl' 2>/dev/null");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/piCommands.test.ts`
Expected: FAIL — cannot resolve `../../src/pi/piCommands`.

- [ ] **Step 3: Implement the command builders**

`quoteShell` wraps in single quotes and replaces each `'` with `'\''`.
`encodePiCwd` strips a leading `/`, replaces every `/`, `\`, `:` with `-`, and
wraps the result in `--`. The four builders produce exactly the strings the
tests assert.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/piCommands.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/piCommands.ts tests/unit/piCommands.test.ts
git commit -m "feat(pi): build the remote discovery and read commands"
```

---

### Task 5: Read projects and sessions through a transport

**Files:**
- Create: `src/pi/piRepository.ts`
- Create: `src/pi/index.ts`
- Test: `tests/unit/piRepository.test.ts`

**Interfaces:**
- Consumes: `parsePiSession`, `sessionPreview` (Task 2); `encodePiCwd`,
  `listSessionDirsCommand`, `readProjectCwdCommand`, `listSessionFilesCommand`,
  `readSessionTailCommand` (Task 4); `candidateSessionRoots` (Task 3).
- Produces:
  - `interface PiTransport { exec(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }>; sftpRead(path: string, maxBytes: number): Promise<string> }`
  - `interface PiProject { path: string; name: string }`
  - `interface PiSessionMeta { path: string; id: string; name: string | null; updatedAtMs: number; preview: string | null; turnCount: number }`
  - `class PiRepositoryError extends Error`
  - `class PiRepository { constructor(transport: PiTransport, sessionRoot: string); listProjects(): Promise<PiProject[]>; listSessions(project: PiProject): Promise<PiSessionMeta[]>; readSession(path: string): Promise<ParsedPiSession> }`
  - `src/pi/index.ts` re-exports the public surface of `types`,
    `parsePiSession`, `sessionRoot`, `piCommands`, `piRepository`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/piRepository.test.ts
import { describe, expect, it, vi } from 'vitest';
import { PiRepository, PiRepositoryError, type PiTransport } from '../../src/pi/piRepository';

const ROOT = '/home/projects/.pi-agent/sessions';
const DIR = `${ROOT}/--home-kai--`;

function transport(handlers: Record<string, string>): PiTransport {
  return {
    exec: vi.fn(async (command: string) => ({ stdout: handlers[command] ?? '', stderr: '', exitCode: 0 })),
    sftpRead: vi.fn(async () => ''),
  };
}

describe('PiRepository.listProjects', () => {
  it('reads cwd from each dir header and de-duplicates', async () => {
    const t = transport({
      "ls -1 -- '/home/projects/.pi-agent/sessions' 2>/dev/null": '--home-kai--\n--junk--\n--home-projects-auto_sci--',
      [`for f in '${DIR}'/*.jsonl; do head -n 1 "$f"; break; done 2>/dev/null`]:
        '{"type":"session","version":3,"id":"s","cwd":"/home/kai"}',
      [`for f in '${ROOT}/--junk--'/*.jsonl; do head -n 1 "$f"; break; done 2>/dev/null`]: '',
      "for f in '/home/projects/.pi-agent/sessions/--home-projects-auto_sci--'/*.jsonl; do head -n 1 \"$f\"; break; done 2>/dev/null":
        '{"type":"session","version":3,"id":"s","cwd":"/home/projects/auto_sci"}',
    });
    expect(await new PiRepository(t, ROOT).listProjects()).toEqual([
      { path: '/home/kai', name: 'kai' },
      { path: '/home/projects/auto_sci', name: 'auto_sci' },
    ]);
  });

  it('returns [] when the root has no dirs', async () => {
    expect(await new PiRepository(transport({}), ROOT).listProjects()).toEqual([]);
  });

  it('throws a typed error when the listing command fails', async () => {
    const t: PiTransport = { exec: vi.fn(async () => ({ stdout: '', stderr: 'no such dir', exitCode: 2 })), sftpRead: vi.fn() };
    await expect(new PiRepository(t, ROOT).listProjects()).rejects.toBeInstanceOf(PiRepositoryError);
  });
});

describe('PiRepository.listSessions', () => {
  it('maps find output to session metadata, newest first', async () => {
    const findCmd = `find '${DIR}' -maxdepth 1 -name '*.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn`;
    const a = `${DIR}/2026-10-18T01-52-19-726Z_01a14cb5-b70d-76f4-b739-6721b8b88c02.jsonl`;
    const t = transport({
      [findCmd]: `1792288352.0 ${a}\n`,
      [`tail -c 65536 -- '${a}' 2>/dev/null`]: [
        '{"type":"session","version":3,"id":"01a14cb5","cwd":"/home/kai"}',
        '{"type":"message","id":"u","parentId":"s","timestamp":"2026-10-18T01:52:32.023Z","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1792288352007}}',
        '{"type":"message","id":"a","parentId":"u","timestamp":"2026-10-18T01:52:40.896Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"timestamp":1792288356896}}',
        '{"type":"session_info","id":"n","parentId":"a","timestamp":"2026-10-18T01:52:41.000Z","name":"ninfer-check"}',
      ].join('\n'),
    });
    expect(await new PiRepository(t, ROOT).listSessions({ path: '/home/kai', name: 'kai' })).toEqual([
      { path: a, id: '01a14cb5-b70d-76f4-b739-6721b8b88c02', name: 'ninfer-check', updatedAtMs: 1792288352000, preview: 'done', turnCount: 2 },
    ]);
  });
});

describe('PiRepository.readSession', () => {
  it('prefers SFTP and falls back to tail on failure', async () => {
    const t = transport({});
    t.sftpRead = vi.fn(async () => { throw new Error('too big'); });
    const parsed = await new PiRepository(t, ROOT).readSession(`${DIR}/x.jsonl`);
    expect(parsed.turns).toEqual([]);
    expect(t.exec).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/piRepository.test.ts`
Expected: FAIL — cannot resolve `../../src/pi/piRepository`.

- [ ] **Step 3: Implement `PiRepository`**

- `listProjects()`: `exec(listSessionDirsCommand(root))`; on `exitCode !== 0`
  throw `PiRepositoryError` (Review Focus 5); keep only lines matching
  `/^--.*--$/`; for each, `exec(readProjectCwdCommand(`${root}/${dir}`))`,
  `JSON.parse` the first line, take `cwd`; skip on empty/parse failure
  (Review Focus 4); map to `{ path: cwd, name: cwd segment after last '/' }`;
  de-duplicate by `path`.
- `listSessions(project)`: `exec(listSessionFilesCommand(dir))` where
  `dir = `${root}/${encodePiCwd(project.path)}``; parse `"<epoch> <path>"`
  lines; for each path read `exec(readSessionTailCommand(path, 65536))` and
  `parsePiSession` it; `id` = the filename segment after the last `_` minus
  `.jsonl`; `updatedAtMs = Math.round(epoch * 1000)`; `name`/`preview`/
  `turnCount` from the parse.
- `readSession(path)`: try `sftpRead(path, 262144)`; on throw, use
  `exec(readSessionTailCommand(path, 262144)).stdout`; return
  `parsePiSession(text)`.

Define `SESSION_TAIL_BYTES`/`SESSION_FULL_BYTES` as named constants rather than
inline literals. `src/pi/index.ts` re-exports the public names.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/piRepository.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the whole new suite and typecheck**

Run: `pnpm exec vitest run tests/unit/piParseSession.test.ts tests/unit/piSessionRoot.test.ts tests/unit/piCommands.test.ts tests/unit/piRepository.test.ts`
Expected: PASS (22 tests).
Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/pi/piRepository.ts src/pi/index.ts tests/unit/piRepository.test.ts
git commit -m "feat(pi): list projects/sessions and read a session over a transport"
```

---

## Self-Review

- **Spec coverage:** §9.1 project discovery → Tasks 4–5; §9.2 session listing →
  Task 5; §9.3 parsing (drop tool/thinking/custom, turn grouping) → Task 2;
  §7.4 types → Tasks 2/5; §5 environment restore → Task 1. §6 (shell removal),
  §8 (screens), §7.1–7.3 (native secrets), §9.4 (PTY send), §10 (visual) are
  **out of this plan** — see the sequence below.
- **Type consistency:** `ParsedPiSession`, `PiTurn`, `PiProject`,
  `PiSessionMeta`, `PiTransport` are used with the same shapes across tasks;
  `turnCount` replaces the spec's `messageCount` (counts rendered turns, not
  raw messages) — noted so later UI code uses the right field.
- **Review Focus:** RF1 → Task 2 truncated-line test; RF2 → Task 2 string
  test; RF3 → Task 2 thinking-only test; RF4 → Task 5 empty-root/no-header;
  RF5 → Task 5 failing-command test.

## Follow-on plans (all written; none implemented)

2. [`2026-10-19-phone-shell-tabs-chat.md`](2026-10-19-phone-shell-tabs-chat.md)
   — **App shell, three tabs, WeChat visual layer.** One shell, the bottom tab
   bar, Connections/Projects/Sessions/Chat screens, phone-layer WeChat tokens,
   key-auth connect, and the deletion of the shared shell + unused screens.
   **Owns `resolveSessionRoot(transport, home, env, override)`** (Task 2), which
   probes the candidates from `candidateSessionRoots` (Task 3) in order with
   `test -d` and returns the first that exists — Plan 1 exports the candidate
   list but deliberately does not probe, so the spec §9.1 "first that exists"
   resolution is unimplemented until Plan 2 lands. Plan 2 also inherits the
   non-blocking deferrals listed at the end of this document.
3. [`2026-10-19-chat-send-pty-turn.md`](2026-10-19-chat-send-pty-turn.md)
   — **Chat send.** `PiTurnRunner` PTY turn (§9.4), turn completion, the
   Pi-command/PATH per-host config (§9.4), and new-conversation start (§9.5).
4. [`2026-10-19-native-credentials.md`](2026-10-19-native-credentials.md)
   — **Credentials.** Remembered key passphrase and remembered password (§7.1,
   §7.2). Note: password auth itself already exists natively
   (`SshCapabilityPlugin.java:360-368`); the work is persistence + UI.
5. [`2026-10-19-cleanup-android-acceptance.md`](2026-10-19-cleanup-android-acceptance.md)
   — **Build path, reduced gate, emulator acceptance.** The Windows Android
   toolchain, a bash-free debug build, the fork's reduced CI posture, and
   packaged-APK acceptance.

## Deferred from Plan 1's final review (non-blocking)

Plan 1 shipped with these recorded, non-blocking findings. The final
whole-branch review triaged them and did not require a fix; they are carried
here so a later plan can pick them up rather than rediscover them.

- **Exact-manifest JS gate.** `tests/unit/pi*.test.ts` are not registered in
  `scripts/js-unit-test-manifest.json`, and cannot be without collapsing their
  multiple top-level `describe`s (the loader supports one level per file).
  Ships red for `scripts/run-js-unit-gate.sh` only; the branch is unpushed.
  Owned by Plan 2 Task 10 (reconcile the manifest) and finished by Plan 5 Task 4
  (a bash-free `scripts/run-js-unit-gate.ps1`).
- **`parsePiSession.ts:76`** — F3 fixed the blank-`user` flush path, but no
  test exercises a whitespace-only `user` message directly.
- **`sessionRoot.ts`** — duplicate candidates, a trailing-slash `home`, and
  the empty-`home` branch are handled but untested.
- **`piCommands.ts`** — `maxBytes` is interpolated without a runtime guard
  (`NaN`/negative/`Infinity` would yield a malformed `tail -c`); also
  `encodePiCwd`'s `\`/`:` branches and the multi-leading-slash case are
  untested.
- **`piRepository.ts:42`** — `EXEC_TIMEOUT_MS = 15000` is an arbitrary value
  the brief did not constrain (it does stay under the native 30 s exec cap).
- **`piRepository.ts:78`** — `listProjects` probes each project dir's header
  sequentially; the target server has 38 dirs, so this is up to 38 serial SSH
  round-trips. Consider bounded concurrency if the Projects tab feels slow.
- **`piRepository.ts`** — `readCwd` uses the first *non-empty* header line
  where the plan says "the first line" (a strict superset; accepted).
- **Commit `21ff479`** — an `--allow-empty` commit whose message
  ("install dependencies against the core pin") describes no tree change,
  because `node_modules/` is gitignored. Harmless history noise.
- **No test against the captured real session fixture.** The parser is
  exercised by hand-built and synthetic fixtures; the literal 52-entry capture
  from the maintainer's server is deliberately not committed (it is real
  conversation data).
