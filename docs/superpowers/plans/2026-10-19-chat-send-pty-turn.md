# PocketShell WeChat-UI Rebuild — Plan 3: Sending a message (PTY-driven Pi turn)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat composer send. A typed message becomes a Pi turn: the app
drives `pi --session <file>` in the live PTY, waits for the turn to finish, then
re-reads the session file and renders the new turns. The app still *reads* the
conversation; Pi remains the only writer of the session file. No streaming, no
polling loop (D6, Q3).

**Architecture:** A pure `piTurn.ts` builds the command and decides, from a
console tail, whether the turn is done; `PiTurnRunner` sequences PTY-write →
wait → re-read with every side effect injected, so the whole flow is testable in
Node over a fake PTY and a fake filesystem. `resolvePiCommand` fixes the
`pi`-not-on-PATH problem per host (spec §9.4).

**Tech Stack:** Plan 1's `src/pi/`, Plan 2's `PiTransport`/stores, core
`HostCliCore`/`composerDelivery`, `@xterm/xterm` (already present), Capacitor 8.

**Spec:** `docs/superpowers/specs/2026-10-19-wechat-ui-pi-design.md` (§9.4, §9.5, §7.4, D6, D8, Q3)
**Predecessor:** `docs/superpowers/plans/2026-10-19-phone-shell-tabs-chat.md`

## Global Constraints

- **Pi is the only writer of the session file.** The app never appends a turn
  itself; it sends input and re-reads (spec §4, §9.4).
- **No streaming and no polling loop in v1** (Q3/D6). The file is re-read once
  the turn completes and on an explicit user refresh. Do not add `setInterval`.
- **Never interpolate a raw message into a shell string.** The message is quoted
  with Plan 1's `quoteShell`; a message containing `'`, `"`, `$(…)`, backticks or
  newlines must survive verbatim (spec §9.4).
- **`pi` is not on the non-interactive SSH `PATH`** on the target host. Resolve
  it explicitly — per-host `piCommand` → `command -v pi` → the NVM-style
  `/home/projects/softwares/node-*/bin/pi` glob → fail with an actionable error
  (spec §9.4). Never emit a bare `pi`.
- **One session may be open for sending at a time.** Sending while a turn is in
  flight is refused with a visible "a turn is already running" state, never
  silently queued (D8).
- **A failed send must never lose the typed text** (spec §7.4).
- **No new dependency.** This plan leans only on what Plan 2 added.

## Review Focus

1. A message containing a single quote, a `$`, a backtick and a newline must
   round-trip through the built command unchanged — this is the injection
   boundary, and the happy path never exercises it.
2. The completion detector must **not** fire on Pi's *banner*: a console that
   shows the prompt once at startup and once at completion must be counted as
   one completion, not two.
3. When the PTY write fails midway, the runner must report failure and the
   composer must still hold the original text.
4. `resolvePiCommand` must not accept a candidate that does not exist as an
   executable — a path that resolves to a directory or a zero-byte file is a
   failure, not a command.

---

### Task 1: Build the turn command safely

**Files:**
- Create: `src/pi/piTurn.ts`
- Modify: `src/pi/piCommands.ts`, `src/pi/index.ts`
- Test: `tests/unit/piTurnCommand.test.ts`

**Interfaces:**
- Consumes: `quoteShell` (Plan 1).
- Produces:
  - `function buildPiTurnCommand(command: string, sessionFile: string, message: string): string`
  - `const PI_PROMPT_MARKER = '\u203a'` (the `›` Pi prints before its input line) —
    used by Task 2.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/piTurnCommand.test.ts
import { describe, expect, it } from 'vitest';
import { buildPiTurnCommand } from '../../src/pi/piTurn';

describe('buildPiTurnCommand', () => {
  it('passes the message as a single quoted argument', () => {
    expect(buildPiTurnCommand('pi', '/r/a.jsonl', 'summarise the log'))
      .toBe("pi --session '/r/a.jsonl' 'summarise the log'");
  });

  it('neutralises quotes, dollars, backticks and newlines', () => {
    const msg = "it's $HOME `id`\nline two";
    const cmd = buildPiTurnCommand('pi', '/r/a.jsonl', msg);
    expect(cmd.startsWith('pi --session ')).toBe(true);
    expect(cmd).not.toContain('`id`');
    expect(cmd.split('\n')).toHaveLength(1);
  });

  it('quotes a session path containing a space', () => {
    expect(buildPiTurnCommand('pi', '/r/my dir/a.jsonl', 'x'))
      .toContain("'/r/my dir/a.jsonl'");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/piTurnCommand.test.ts`
Expected: FAIL — cannot resolve `../../src/pi/piTurn`.

- [ ] **Step 3: Implement**

`buildPiTurnCommand` uses Plan 1's `quoteShell` on both the session path and the
message. Newlines are the one case a shell cannot receive literally through a
line-oriented PTY: escape them as `\n` inside the quoted string and let Task 2
document that a multi-line message is delivered as one line — this keeps the
command single-line and injection-free (Review Focus 1). Re-export from
`src/pi/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/piTurnCommand.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/piTurn.ts src/pi/piCommands.ts src/pi/index.ts tests/unit/piTurnCommand.test.ts
git commit -m "feat(pi): build a single-line, injection-safe pi turn command"
```

---

### Task 2: Detect the end of a turn

**Files:**
- Create: `src/pi/turnCompletion.ts`
- Test: `tests/unit/turnCompletion.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `function countPrompts(consoleText: string): number`
  - `function isTurnComplete(baseline: number, consoleText: string): boolean`
  - `function createConsoleTracker(): { push(chunk: string): void; text(): string }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/turnCompletion.test.ts
import { describe, expect, it } from 'vitest';
import { countPrompts, createConsoleTracker, isTurnComplete } from '../../src/pi/turnCompletion';

describe('turn completion', () => {
  it('counts prompt markers', () => {
    expect(countPrompts('ready\n\u203a ')).toBe(1);
    expect(countPrompts('\u203a a\n\u203a b')).toBe(2);
  });

  it('does not fire while the console is unchanged', () => {
    expect(isTurnComplete(1, 'ready\n\u203a ')).toBe(false);
  });

  it('fires when a further prompt appears', () => {
    expect(isTurnComplete(1, 'ready\n\u203a \nanswer\n\u203a ')).toBe(true);
  });

  it('ignores a redraw that reprints the same prompt text', () => {
    expect(isTurnComplete(1, '\u203a \r\u203a ')).toBe(false);
  });

  it('tracks chunks across partial escape sequences', () => {
    const t = createConsoleTracker();
    t.push('\u203a ');
    t.push('work');
    t.push('\u203a ');
    expect(countPrompts(t.text())).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/turnCompletion.test.ts`
Expected: FAIL — cannot resolve `../../src/pi/turnCompletion`.

- [ ] **Step 3: Implement**

`createConsoleTracker` accumulates the PTY tail and strips ANSI/CR redraws:
collapse `\r`-overwrites to the final line, drop SGR sequences
(`/\x1b\[[0-9;]*m/g`). `countPrompts` counts `PI_PROMPT_MARKER` occurrences in the
cleaned text. `isTurnComplete` compares against the prompt count captured
*before* the write — the first prompt is the banner/readline prompt, so a
completion needs strictly more than the baseline (Review Focus 2). Keep the
tracker bounded (cap the retained text) so a long shell session cannot grow
without limit.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/turnCompletion.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/turnCompletion.ts tests/unit/turnCompletion.test.ts
git commit -m "feat(pi): detect the end of a pi turn from the console tail"
```

---

### Task 3: Resolve the remote `pi` command

**Files:**
- Create: `src/pi/resolvePiCommand.ts`
- Modify: `src/pi/piCommands.ts`, `src/pi/index.ts`
- Test: `tests/unit/piResolveCommand.test.ts`

**Interfaces:**
- Consumes: `PiTransport`.
- Produces: `function resolvePiCommand(transport: PiTransport, override?: string): Promise<{ ok: true; command: string } | { ok: false; error: string }>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/piResolveCommand.test.ts
import { describe, expect, it, vi } from 'vitest';
import { resolvePiCommand } from '../../src/pi/resolvePiCommand';

const t = (out: string, exitCode = 0) => ({ exec: vi.fn(async () => ({ stdout: out, stderr: '', exitCode })), sftpRead: vi.fn() });

describe('resolvePiCommand', () => {
  it('prefers a working per-host override', async () => {
    const r = await resolvePiCommand(t('/opt/bin/pi\n') as never, '/opt/bin/pi');
    expect(r).toEqual({ ok: true, command: '/opt/bin/pi' });
  });

  it('accepts an override only when it is executable', async () => {
    const r = await resolvePiCommand(t('', 1) as never, '/opt/bin/pi');
    expect(r.ok).toBe(false);
  });

  it('falls back to command -v pi', async () => {
    const r = await resolvePiCommand(t('/usr/local/bin/pi\n') as never);
    expect(r).toEqual({ ok: true, command: '/usr/local/bin/pi' });
  });

  it('falls back to the node bin glob when pi is not on PATH', async () => {
    const transport = { exec: vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: '/home/projects/softwares/node-v25.2.1-linux-x64/bin/pi\n', stderr: '', exitCode: 0 }),
      sftpRead: vi.fn() };
    const r = await resolvePiCommand(transport as never);
    expect(r).toEqual({ ok: true, command: '/home/projects/softwares/node-v25.2.1-linux-x64/bin/pi' });
  });

  it('fails with an actionable error when nothing is found', async () => {
    const r = await resolvePiCommand(t('', 1) as never);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/pi .*(not found|设置|set)/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/piResolveCommand.test.ts`
Expected: FAIL — cannot resolve `../../src/pi/resolvePiCommand`.

- [ ] **Step 3: Implement**

Probe in order, each as an executable check (`test -x`, not `test -d` — Review
Focus 4): the override, `command -v pi`, then
`ls -1 /home/projects/softwares/node-*/bin/pi 2>/dev/null | head -n1`. Add each
probe as a builder in `piCommands.ts` so the strings are asserted there too.
Return the first hit; otherwise an error naming the Pi command field in the
connection editor.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/piResolveCommand.test.ts tests/unit/piCommands.test.ts`
Expected: PASS (6 + 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/resolvePiCommand.ts src/pi/piCommands.ts src/pi/index.ts tests/unit/piResolveCommand.test.ts tests/unit/piCommands.test.ts
git commit -m "feat(pi): resolve the remote pi binary per host"
```

---

### Task 4: `PiTurnRunner` — write, wait, re-read

**Files:**
- Create: `src/pi/piTurnRunner.ts`
- Test: `tests/unit/piTurnRunner.test.ts`

**Interfaces:**
- Consumes: `buildPiTurnCommand` (Task 1), `createConsoleTracker`/`isTurnComplete`
  (Task 2), `resolvePiCommand` (Task 3), `readSession` (Plan 1).
- Produces:
  - `interface TurnPty { write(data: string): void; onData(cb: (chunk: string) => void): () => void }`
  - `interface PiTurnRunnerDeps { pty: TurnPty; transport: PiTransport; piCommand: string; readSession: typeof readSession; timeoutMs?: number; now?: () => number }`
  - `function createPiTurnRunner(deps: PiTurnRunnerDeps): { send(sessionFile: string, message: string): Promise<{ ok: true; session: ParsedPiSession } | { ok: false; error: string }>; isBusy(): boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/piTurnRunner.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createPiTurnRunner } from '../../src/pi/piTurnRunner';

function harness(opts: { writeFails?: boolean } = {}) {
  let cb: ((c: string) => void) | undefined;
  const writes: string[] = [];
  const pty = {
    write: vi.fn((d: string) => { if (opts.writeFails) throw new Error('pty closed'); writes.push(d); cb?.('\u203a '); }),
    onData: (c: (chunk: string) => void) => { cb = c; return () => { cb = undefined; }; },
  };
  const readSession = vi.fn(async () => ({ version: 3, id: 'a', cwd: '/home/kai', name: null, turns: [{ role: 'user' as const, text: 'hi', timestampMs: 1 }] }));
  const runner = createPiTurnRunner({ pty, transport: {} as never, piCommand: '/opt/bin/pi', readSession, timeoutMs: 50 });
  return { runner, pty, readSession, writes, emit: (c: string) => cb?.(c) };
}

describe('createPiTurnRunner', () => {
  it('writes the built command once, then re-reads the session', async () => {
    const h = harness();
    const p = h.runner.send('/r/a.jsonl', 'hi');
    h.emit('\u203a ');
    expect(await p).toEqual({ ok: true, session: expect.objectContaining({ id: 'a' }) });
    expect(h.readSession).toHaveBeenCalledWith(expect.anything(), '/r/a.jsonl');
  });

  it('refuses a second send while a turn is in flight', async () => {
    const h = harness();
    const first = h.runner.send('/r/a.jsonl', 'one');
    await expect(h.runner.send('/r/a.jsonl', 'two')).resolves.toEqual({ ok: false, error: expect.stringMatching(/running/i) });
    h.emit('\u203a ');
    await first;
    expect(h.runner.isBusy()).toBe(false);
  });

  it('reports a failed write without throwing', async () => {
    const h = harness({ writeFails: true });
    const r = await h.runner.send('/r/a.jsonl', 'hi');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('pty closed');
    expect(h.runner.isBusy()).toBe(false);
  });

  it('times out and reports it', async () => {
    const h = harness();
    const r = await h.runner.send('/r/a.jsonl', 'hi');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/timed out|timeout/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/piTurnRunner.test.ts`
Expected: FAIL — cannot resolve `../../src/pi/piTurnRunner`.

- [ ] **Step 3: Implement**

`send` refuses when `isBusy()` (Review Focus: D8). Otherwise it captures the
baseline prompt count from the tracker, writes
`buildPiTurnCommand(piCommand, sessionFile, message) + '\r'`, and resolves on the
first tracker read where `isTurnComplete(baseline, text)` — or on `timeoutMs`,
whichever first; a timeout is reported, never thrown. Every exit path clears the
busy flag and unsubscribes the PTY listener. On success it calls `readSession`
and returns the parsed session; a `readSession` failure is reported as an error
too (Review Focus 3 is about the composer keeping the text — Task 5).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/piTurnRunner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/piTurnRunner.ts tests/unit/piTurnRunner.test.ts
git commit -m "feat(pi): send a turn over the PTY and re-read the session"
```

---

### Task 5: Wire the composer

**Files:**
- Create: `src/components/sessions/ChatComposer.vue`
- Modify: `src/components/sessions/ChatScreen.vue`, `src/stores/sessions.ts`
- Test: `tests/unit/sessionsSend.test.ts`

**Interfaces:**
- Consumes: `PiTurnRunner` (Task 4), `useSessionsStore` (Plan 2).
- Produces: `useSessionsStore().send(text)` → `'sent' | 'busy' | 'error'`, plus
  `{ sending: boolean; sendError: string | null }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/sessionsSend.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createSessionsStore } from '../../src/stores/sessions';

const session = { version: 3, id: 'a', cwd: '/home/kai', name: null, turns: [] };

describe('sessions store send', () => {
  it('replaces the open session with the one the runner read back', async () => {
    const runner = { send: vi.fn(async () => ({ ok: true, session: { ...session, turns: [{ role: 'user', text: 'hi', timestampMs: 1 }] } })), isBusy: () => false };
    const store = createSessionsStore({ listSessions: vi.fn(), readSession: vi.fn(), runner } as never);
    await store.openSession('/r/a.jsonl');
    expect(await store.send('hi')).toBe('sent');
    expect(store.open?.turns).toHaveLength(1);
    expect(store.sending).toBe(false);
  });

  it('returns busy without writing when a turn is in flight', async () => {
    const runner = { send: vi.fn(), isBusy: () => true };
    const store = createSessionsStore({ listSessions: vi.fn(), readSession: vi.fn(), runner } as never);
    await store.openSession('/r/a.jsonl');
    expect(await store.send('hi')).toBe('busy');
    expect(runner.send).not.toHaveBeenCalled();
  });

  it('keeps the error and reports it without throwing', async () => {
    const runner = { send: vi.fn(async () => ({ ok: false, error: 'timed out' })), isBusy: () => false };
    const store = createSessionsStore({ listSessions: vi.fn(), readSession: vi.fn(), runner } as never);
    await store.openSession('/r/a.jsonl');
    expect(await store.send('hi')).toBe('error');
    expect(store.sendError).toContain('timed out');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/sessionsSend.test.ts`
Expected: FAIL — the store has no `send`.

- [ ] **Step 3: Implement**

Add `send`/`sending`/`sendError` to the Plan 2 store, with the runner injected
alongside `listSessions`/`readSession`. Then enable the Plan 2 composer:
multi-line text, send on tap, disabled while `sending`, spinner during the turn,
inline error on failure, and **the text is only cleared after `'sent'`** — on
`'busy'` or `'error'` it stays in the box so nothing is lost (Review Focus 3,
spec §7.4). Add a small 打开终端 escape hatch so the user can finish a stuck turn
in the terminal.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/sessionsSend.test.ts tests/unit/sessionsStore.test.ts`
Expected: PASS (3 + 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/sessions/ChatComposer.vue src/components/sessions/ChatScreen.vue src/stores/sessions.ts tests/unit/sessionsSend.test.ts
git commit -m "feat(chat): send a message as a pi turn and show the new replies"
```

---

### Task 6: Start a new conversation

**Files:**
- Create: `src/pi/createSession.ts`
- Modify: `src/components/sessions/SessionList.vue`, `src/stores/sessions.ts`
- Test: `tests/unit/createSession.test.ts`

**Interfaces:**
- Consumes: `buildPiTurnCommand` (Task 1), `PiTransport`, `resolvePiCommand` (Task 3).
- Produces: `function startConversation(deps: { transport: PiTransport; piCommand: string; projectPath: string; firstMessage: string; sessionFile: string }): Promise<{ ok: true } | { ok: false; error: string }>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/createSession.test.ts
import { describe, expect, it, vi } from 'vitest';
import { startConversation } from '../../src/pi/createSession';

describe('startConversation', () => {
  it('runs pi with the first message in the project directory', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const r = await startConversation({ transport: { exec, sftpRead: vi.fn() } as never, piCommand: '/opt/bin/pi', projectPath: '/home/projects/x', firstMessage: 'go', sessionFile: '/r/new.jsonl' });
    expect(r.ok).toBe(true);
    const cmd = exec.mock.calls[0][0] as string;
    expect(cmd).toContain("cd '/home/projects/x'");
    expect(cmd).toContain("--session '/r/new.jsonl'");
  });

  it('surfaces a non-zero exit as an error', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: 'boom', exitCode: 1 }));
    const r = await startConversation({ transport: { exec, sftpRead: vi.fn() } as never, piCommand: 'pi', projectPath: '/p', firstMessage: 'go', sessionFile: '/r/n.jsonl' });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/createSession.test.ts`
Expected: FAIL — cannot resolve `../../src/pi/createSession`.

- [ ] **Step 3: Implement**

A new conversation is created by Pi, not the app, so run the turn
non-interactively from the project directory with a fresh session path, then let
the normal read path discover the file. Generate the session path under the
resolved root using Pi's file convention; if that is too brittle, run with a
`--session` path the app will then read (spec §9.5). Wire the SessionList `+`
button to `startConversation` and navigate into the new chat on success.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/createSession.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/createSession.ts src/components/sessions/SessionList.vue src/stores/sessions.ts tests/unit/createSession.test.ts
git commit -m "feat(chat): start a new conversation from a project"
```

---

## Self-Review

- **Spec coverage:** §9.4 → Tasks 1, 3, 4; §9.5 → Task 6; §7.4 → Task 5; Q3/D6
  (no streaming/polling) → Global Constraints and Task 4's timeout; D8 → Task 4's
  busy guard.
- **Review Focus:** RF1 → Task 1; RF2 → Task 2; RF3 → Task 5; RF4 → Task 3.
- **Interface consistency:** `PiTurnRunner` consumes Plan 2's `PiTransport` and
  Plan 1's `readSession`/`ParsedPiSession`; `resolvePiCommand` reads the
  `piCommand` field Task 1 of Plan 2 added to `SavedHostV2`.
- **Deliberately out of scope:** streaming partial replies, a send queue, and
  multi-session concurrency — all deferred by Q3/D8.
- **Not verifiable here:** the actual PTY round-trip needs a device (Plan 5);
  Tasks 1–4 are pure and Task 5/6 are covered by store tests.

## Follow-on plans

4. `2026-10-19-native-credentials.md`
5. `2026-10-19-cleanup-android-acceptance.md`
