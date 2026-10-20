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
- **No streaming in v1** (D6). The file is re-read once the turn completes and on
  an explicit user refresh. Completion uses the bounded re-read poll of R18.2
  step 4; do not add `setInterval` (recursive `setTimeout` only).
- **The message is never interpolated into a shell string** (R18.2 step 3): it is
  written to Pi's PTY as one line of terminal input, so nothing about its content
  can be parsed by a shell. Only the `piCommand` *path* and the project directory
  in the open command are shell-quoted, with `quoteShell`.
- **`pi` is not on the non-interactive SSH `PATH`** on the target host. Resolve
  it explicitly — per-host `piCommand` → `command -v pi` → the NVM-style
  `/home/projects/softwares/node-*/bin/pi` glob → fail with an actionable error
  (spec §9.4). Never emit a bare `pi`.
- **One session may be open for sending at a time.** Sending while a turn is in
  flight is refused with a visible "a turn is already running" state, never
  silently queued (D8).
- **A failed send must never lose the typed text** (spec §7.4).
- **No new dependency.** This plan leans only on what Plan 2 added.

## R18 — preflight corrections (authoritative, resolved 2026-10-19)

A preflight against `ab05c07` found this plan names several symbols that do not
exist and, more importantly, omits the production PTY a turn needs. **Where this
section and the task text below disagree, this section wins.** The task bodies are
still the checklist; R18 rewrites their *content*.

### R18.1 Facts the plan got wrong
- The host record is **`SavedHost`**, not `SavedHostV2`
  (`src/platform/android/hostStore.ts:25-42`), and it **already has** `piCommand`
  and `piSessionsDir` (`hostStore.ts:38-41`), persisted (`:139-140`), validated
  (`:99-101`), edited (`src/components/connections/ConnectionEditor.vue:141-149`)
  and pinned by `tests/unit/hostStoreAuth.test.ts:38-45`. Consume the field; do
  not add it.
- There is **no free `readSession`**. Only `PiRepository.readSession(path)`
  (`src/pi/piRepository.ts:126-138`). Inject `(path) => Promise<ParsedPiSession>`.
- `PiTransport` is a type in `src/pi/piRepository.ts:11-17`:
  `exec(command, timeoutMs) → { stdout; stderr; exitCode: number | null }` and
  `sftpRead(path, maxBytes) → string`.
- `quoteShell` (`src/pi/piCommands.ts:1-3`) escapes **only** `'`; it does not
  touch newlines, `$`, backticks or `"`. Task 1's original tests are therefore
  unsatisfiable as written.
- `src/pi/index.ts` is a **dead barrel** (no importer anywhere in `src/` or
  `tests/`). Drop the "re-export from `src/pi/index.ts`" steps; import leaves
  directly, as the rest of the tree does.
- **§9.5 does not exist.** The new-conversation requirements are §8.5
  (`spec:258-259`) plus §9.4's "Known risks" (`spec:403-407`).
- Citations: the non-streaming rule is **D6** (`spec:450`) — `Q3` is password
  auth (`spec:480`); one-turn-at-a-time is **D10** / §9.4:401 (`spec:454-456`) —
  `D8` is the single live connection (`spec:452`).
- Step-4 test counts are wrong: `piResolveCommand.test.ts` has 5 `it`s and
  `sessionsStore.test.ts` has 13.

### R18.2 The turn model — follow §9.4, not the task text
§9.4 (`spec:367-401`) prescribes, and this plan now implements:
1. Open **one** PTY per open chat, in the project `cwd`, running an
   **interactive** `pi --session <path>` — one channel of the 8 (D10). **No
   `exec` for a turn**: the Android exec path caps at 30 s/120 s
   (`spec:382-386`), which is exactly why the spec rejects it.
2. Wait for Pi to be **ready** (its first prompt) before writing anything.
3. Write the message as **one line of terminal input** (reuse
   `src/session/composerDelivery.ts`) — insert, then submit. Because this is PTY
   input to `pi` and never a shell string, the message content cannot be
   interpolated or injected; the only shell boundary is the `piCommand` path and
   the directory in the open command (R18.3).
4. Detect completion by **re-reading the session file** until a **new assistant
   turn** appears, bounded by a timeout (spec §9.4 step 3). The `.jsonl` on disk
   is the single source of truth (D10). A bounded completion poll is the spec's
   mechanism and is not streaming.
5. Keep the PTY for the next message in the same chat; close it on leave, and
   tear it down on host switch/reconnect — an in-flight turn is **abandoned**, the
   file keeps whatever Pi already wrote (D10).

This replaces the plan's per-turn `pi --session <f> '<msg>'` argv command, its
prompt-count-as-completion test, and `PI_PROMPT_MARKER`-based completion.

### R18.3 The missing production PTY (the plan's biggest gap)
`TurnPty` exists only as a test double — nothing in the tree can construct one.
`TerminalPty` (`src/session/terminalPty.ts:12-23`) cannot host a turn: it attaches
by aplexer session name, has a **single** `onData` slot shared with the terminal
screen, and cannot run an arbitrary command. Add a phone-layer seam in the same
style as `terminalPty.ts`:

```ts
// src/session/turnPty.ts
export interface TurnPtyHandle {
  onData(cb: (chunk: string) => void): () => void;      // returns unsubscribe
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
export interface TurnPtyOpener {
  open(command: string, geometry: { cols: number; rows: number }): Promise<TurnPtyHandle>;
}
export function installTurnPtyOpener(opener: TurnPtyOpener | null): void;
export function turnPtyOpener(): TurnPtyOpener;   // throws when nothing installed
```

Implemented in `src/phone/PhoneApp.vue` over `sshCapability.openPty({ connectionId,
generationId, requestId, command, cols, rows, term })` plus a `readPty` pump,
`writePty` and `closePty` (`src/native/sshCapability.ts:161-164`,
`vendor/pocketshell-core/src/sshCapability.ts:154-160,277-281`), reusing the
existing `liveConnectionRef()` (`PhoneApp.vue:268-274`). `openPty` has **no cwd**,
so the command must be `cd '<projectPath>' && exec <piCommand>` with both the path
and the command quoted via `quoteShell`. Install it with the other seams on mount
and release it on unmount; the runner closes its own handle on leave / host
switch / reconnect.

`src/session/composerDelivery.ts` is currently an orphan (its only caller is the
legacy `PromptComposer.vue`). Reusing it here makes it live — so remove it from
Task 10b's orphan list, alongside `appLifecycle.ts` and `homeSurface.ts`.

### R18.4 Corrected per-task specs
- **Task 1** → `src/pi/piTurn.ts` exports `buildPiOpenCommand(piCommand,
  projectPath, sessionFile?)` (shell-safe: `quoteShell` the path and the command;
  reject a `piCommand` containing a newline) and `toTurnLine(message)` (collapse
  `\r`/`\n` runs to single spaces, trim — a multi-line message is delivered as one
  line, document that). Tests: the *path* and *command* survive `'`, space, `$`,
  backticks as data; a newline in `piCommand` is rejected; `toTurnLine` collapsing.
  **Drop the message-quoting tests** — the message is never a shell string.
- **Task 2** → rename to `src/pi/turnReadiness.ts`: the console tracker plus
  `isPiReady(tracker)` (the first `›` after opening), keeping the ANSI/`\r`
  cleaning, the bounded buffer, and the banner-counts-once rule (old RF2).
  Completion is **not** here (R18.2 step 4).
- **Task 3** → same intent (resolve the `pi` binary: per-host `piCommand` →
  `command -v pi` → the node-glob, each an executable `test -x` check), but
  `piCommand` already lives on `SavedHost`, the new builders go in
  `piCommands.ts`, and the counts are 5 new tests (`piCommands.test.ts` grows).
- **Task 4** → `PiTurnRunner` over `TurnPtyHandle` (R18.3) with an injected
  `readSession(path)`: `send(sessionFile, message)` ensures a ready PTY for this
  chat (opening it if needed), writes `toTurnLine(message)` through
  `composerDelivery` framing, then polls `readSession` for a new assistant turn and
  returns the parsed session (or a typed error); plus `isBusy()` and `dispose()`.
  Every exit path clears busy and unsubscribes. Tests: write → poll → re-read,
  busy refusal, write failure (text kept), timeout, poll that never completes,
  dispose teardown.
- **Task 5** → add `send`/`sending`/`sendError` to `SessionsStoreState`,
  `SessionsStoreDeps` and the `useSessionsStore` re-export
  (`src/stores/sessions.ts:334-345`), composing with the host-keyed D8 guards;
  `send` refuses when no session is open. Create
  `src/components/sessions/ChatComposer.vue` — the inline input at
  `ChatScreen.vue:192-203` is a **disabled placeholder**, not a composer, so
  replace it: multi-line text, send on tap, disabled while `sending`, spinner,
  inline error, **text cleared only on `'sent'`** (spec §7.4). The existing
  打开终端 emit (`ChatScreen.vue:21-27`) is the escape hatch. Count: 3 + 13.
- **Task 6** → new conversation per §8.5/§9.4: open the turn PTY **interactively
  with no `--session`** in the project dir, send the first message, then **adopt**
  the created file by re-listing the project's session dir
  (`listSessionFilesCommand`) and opening the newest — bounded wait, actionable
  error if no new file appears. Undisable `SessionList.vue:44-46`'s `+` when a
  project is selected. **Every Pi-CLI assumption here is UNVERIFIED until a
  device run (Plan 5).**

### R18.5 Gate obligations (all six new test files)
`tsconfig.json:26` typechecks `tests/**`, and `scripts/check-js-unit-results.py`
fails closed on "unexpected files" (`:132-140`) and on any file without exactly
one flat top-level `describe` (`:52-60,118-130,149`). So each new test file must
(1) have exactly one flat top-level `describe`, and (2) be registered in
`scripts/js-unit-test-manifest.json` with titles taken from a fresh
`vitest run --reporter=json` report, never hand-typed. `pnpm exec vitest run <file>`
does **not** check this; only `scripts/run-js-unit-gate.sh` +
`scripts/check-js-unit-results.py` do.

### R18.6 Verification limits
No device here: the real PTY round-trip, Pi's readiness prompt, the file-poll
completion and the new-conversation adoption are **unverifiable on this box** and
belong to Plan 5's packaged acceptance. Tasks 1–4 are pure (unit tests over
fakes); Tasks 5–6 are store/component tests.

### R19 — Task 3 fix round (authoritative, resolved 2026-10-19)
Task 3's `test -x` does **not** meet its own Review Focus 4: POSIX `test -x` is an
`access(X_OK)` check, so it is true for a searchable **directory** and for a
**zero-byte** file carrying the x bit. R18.4 "Task 3" is amended: every probe
guards with `test -f <p> && test -x <p> && test -s <p>` (still never `test -d`).
Test hardening the review proved is missing (each of these mutations currently
leaves 13/13 green):
(a) the resolver tests must give each probe a **distinct** response and assert
`calls[0]` is the override probe — deleting the override probe push keeps the
suite green today, so override preference is unproven;
(b) a probe that exits nonzero **with non-empty stdout** must count as a miss
(removing `result.exitCode === 0` survives today) — plus an
invalid-override-then-PATH-hit case;
(c) the whitespace error is pinned by its own copy (`空格`/`参数`), not the generic
regex;
(d) the pinned builder strings in `piCommands.test.ts` follow the new guard.
Deferred-unchanged spec behaviour (ledger): an override miss falls through to
PATH/glob, so "empty = auto" and "set but invalid" are indistinguishable (unify in
Task 5); a **relative** override is accepted even though Task 4 later runs `exec`
after `cd '<project>'` (Task 5 normalises or rejects); the
`ls -1 … | head -n1` glob pipeline is exposed to a remote `nullglob` (edge;
spec-prescribed). Plan Step 4's "6 + 6" is stale — `piCommands.test.ts` was already
6 before this task.

### R20 — Task 4 design (authoritative, resolved 2026-10-19)
The plan's Task 4 harness (`pty` double, `transport`, `buildPiTurnCommand`,
`isTurnComplete`, `timeoutMs`) is superseded by R18.2/R18.3 + these decisions. The
plan's **four test intents stay**; its literal code does not.

**Seam (`src/session/turnPty.ts`, no production wiring here).**
```ts
export interface TurnPtyGeometry { cols: number; rows: number }
export interface TurnPtyHandle {
  onData(cb: (chunk: string) => void): () => void;
  write(data: string): void;
  close(): void;
}
export interface TurnPtyOpener {
  open(command: string, geometry: TurnPtyGeometry): Promise<TurnPtyHandle>;
}
export function installTurnPtyOpener(opener: TurnPtyOpener | null): void;
export function turnPtyOpener(): TurnPtyOpener; // throws when uninstalled
```
The `PhoneApp.vue` implementation over `sshCapability.openPty`/`readPty`/`writePty`/
`closePty` and the runner's construction are **Task 5's** wiring, not Task 4's.

**`src/pi/piTurnRunner.ts`.**
```ts
export interface PiTurnRunnerDeps {
  openPty(command: string, geometry: TurnPtyGeometry): Promise<TurnPtyHandle>;
  piCommand: string;                // resolved by Task 3's resolvePiCommand
  projectPath: string;              // the chat's project cwd
  readSession(path: string): Promise<ParsedPiSession>;   // injected, one arg
  sleep?(ms: number): Promise<void>;
  now?(): number;
  readyTimeoutMs?: number;          // default 20_000  (Pi never printed a prompt)
  turnTimeoutMs?: number;           // default 120_000 (a turn that never lands)
  pollIntervalMs?: number;          // default 1000
  submitDelayMs?: number;           // default composerTiming.submitDelayMs
}
export function createPiTurnRunner(deps: PiTurnRunnerDeps): {
  send(sessionFile: string, message: string):
    Promise<{ ok: true; session: ParsedPiSession } | { ok: false; error: string }>;
  isBusy(): boolean;
  dispose(): void;
};
```
`send` order (each step's failure is a typed `{ ok: false }`, never a throw):
1. `isBusy()` → refuse with an error matching `/running/i` (D10, one turn at a time).
2. busy = `true`; `try/finally` clears it. **Every** exit path also unsubscribes.
3. Open the PTY **once per runner**: `openPty(buildPiOpenCommand(piCommand,
   projectPath, sessionFile), { cols: 80, rows: 24 })` on the first send; later sends
   reuse the same handle (R18.2: keep the PTY across turns). Geometry is a constant
   here; Task 5/6 may pass the real size.
4. Fresh `createConsoleTracker()` per open; every `onData` chunk pushes into it and
   readiness is **latched** when `isPiReady(tracker.text())` first answers true
   (Task 2 carry-forward). A PTY that never prints a prompt fails after
   `readyTimeoutMs` with a readiness-specific error.
5. Read a **baseline** before writing: `readSession(sessionFile)` with failures
   ignored (a brand-new conversation may not exist yet) → count of `assistant` turns.
6. Deliver `toTurnLine(message)` with `intent: 'submit'` — the CR is the controller's
   separate submit write (R18.2 step 3). Use `createComposerDeliveryController`
   from `src/session/composerDelivery.ts`, extended with a third optional
   `{ submitDelayMs?, pasteGapMs? }` argument (backward compatible) so the injected
   `sleep`/`submitDelayMs` reach the controller; the write effect adapts
   `handle.write(decodeUtf8(bytes))` to `PtyWriteAcknowledgement` and reports a
   thrown write as `{ ok: false, message }`. Map a non-`delivered` result to
   `{ ok: false, error }` — the message text is the error copy.
7. On `delivered`, poll `readSession(sessionFile)` every `pollIntervalMs` until a
   re-read has **more assistant turns than the baseline**, or `now()` passes
   `turnTimeoutMs` → a `timed out`-matching error (never thrown). A `readSession`
   failure mid-poll is retried; only the deadline ends the loop. Recursive
   `setTimeout` via the injected `sleep`; **no `setInterval`**, no unbounded spin.
8. Success returns `{ ok: true, session: <the re-read that completed> }`.
9. `dispose()` closes the handle, unsubscribes, refuses later sends, and makes an
   in-flight `send` resolve `{ ok: false, error }` (D10: abandon, never replay).

**Tests (`tests/unit/piTurnRunner.test.ts`, one flat top-level `describe`)** — the
plan's four intents plus R18.4's: (a) opens with the built command, delivers the
line + CR, polls, and returns the polled session; (b) busy refusal; (c) write
failure → error carries the double's message, busy cleared, **no poll**; (d)
never-ready PTY → readiness timeout; (e) a poll that never completes → turn
timeout; (f) a `readSession` that fails then recovers → returns when the assistant
turn appears; (g) a second send reuses the handle (opener called once) and a later
send after completion works; (h) `dispose` closes + unsubscribes + refuses later
sends. Inject `sleep` (instant), `now` (advanced by the test) and
`submitDelayMs: 0` so no real timer or wall-clock dependency exists.

### R21 — Task 4 hardening (authoritative, resolved 2026-10-19)
The Task 4 review approved the module but proved one gap the runner owns: every
`readSession` is raced only against disposal, so a read that **never settles**
keeps `send` alive past `turnTimeoutMs` with `busy` still set (only `dispose()`
escapes). `turnTimeoutMs` is the runner's contract, so fix it here, not in Task 5:
- A read that has not settled by the turn deadline must yield the same typed
  timeout result as an unchanged session — busy cleared, listener unsubscribed.
  Bound it with the injected `sleep`/`now` only (no real `setTimeout` left
  dangling, no `setInterval`, no wall-clock dependence in tests); add a test with
  a `readSession` that returns a never-resolving promise.
- Collapse the two duplicated deadline guards in `pollForAssistant` into one
  checkable place (the review found each branch individually mutation-uncovered).
- Refuse an **empty** message before opening the PTY and before the delivery
  controller sees it (`toTurnLine('') === ''`), with a plain typed error — today
  it opens a PTY just to get `not-sent (empty-payload)` printed at the user.
Unchanged: the English typed error strings stay (the plan's tests pin them); Task 5
localises at display time. Geometry, `decodeUtf8` and the readiness model are out
of scope.



---

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

### Task 7: Register the Plan 3 tests and run the real gate

**Files:**
- Modify: `scripts/js-unit-test-manifest.json`
- Verification only (no new test)

- [ ] **Step 1: Register every new test file** (R18.5)

For each file created by Tasks 1–6, add one manifest entry with exactly that
file's single flat top-level `describe` as `suite` and its exact leaf `it` titles
as `tests`, taken from a fresh
`npx vitest run --reporter=json --outputFile.json=build/test-results/js-unit/vitest-results.json`
report — never hand-typed.

- [ ] **Step 2: Run the checker**

`& C:\Python314\python.exe scripts/check-js-unit-results.py --report build/test-results/js-unit/vitest-results.json`
Expected: no "unexpected files" and no "test set differs". The only permitted
complaint is the pre-existing Windows-environmental red (`devBrowserServer`
`.bin/vite` ENOENT / `sshKeySetup` ×3), which cannot run on this box.

- [ ] **Step 3: Report**

Report the manifest entry count before/after, the checker output, the full-suite
counts, and `npx vue-tsc --noEmit` exit 0.

---

## Self-Review

- **Spec coverage:** §9.4 → Tasks 1, 3, 4 (and R18.2/R18.3 for the turn model and
  the PTY); §8.5 + §9.4 "Known risks" → Task 6; §7.4 → Task 5; **D6** (no
  streaming; in-chat pull-to-refresh only) → Global Constraints + Task 4's
  completion poll; **D10** (phone-owned turn PTY, abandoned not resumed) →
  R18.3 + Task 4; R18.5 → Task 7.
- **Review Focus:** RF1 → Task 1 (now the *path/command* injection boundary, not
  the message); RF2 → Task 2 (readiness counts the banner prompt once); RF3 →
  Task 5 (a failed send keeps the typed text); RF4 → Task 3 (`test -x`, not
  `test -d`).
- **Interface consistency:** `PiTurnRunner` consumes Plan 2's `PiTransport` and
  **`PiRepository.readSession(path)`** (there is no free `readSession`) plus
  `ParsedPiSession`; `resolvePiCommand` reads the `piCommand` field that already
  exists on **`SavedHost`**.
- **Deliberately out of scope:** streaming partial replies, a send queue, and
  multi-session concurrency — deferred by D6/D10.
- **Not verifiable here:** the PTY round-trip, Pi's readiness prompt, the
  completion poll against a real Pi, and the new-conversation adoption all need a
  device (Plan 5). Tasks 1–4 are pure and unit-tested over fakes; Tasks 5–6 are
  covered by store/component tests.

## Follow-on plans

4. `2026-10-19-native-credentials.md`
5. `2026-10-19-cleanup-android-acceptance.md`
