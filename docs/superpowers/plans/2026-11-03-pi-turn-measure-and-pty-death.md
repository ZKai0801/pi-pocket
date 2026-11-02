# Pi Turn Measurement and PTY-Death Observability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce real evidence for the "a pi cold start per message" premise before changing any product code, and make a dead turn PTY observable so a write into it can never again report `delivered`.

**Architecture:** Stage 0 is measurement only — no product change. Stage 1a adds a death signal to `TurnPtyHandle` ([src/session/turnPty.ts:14-21](../../../src/session/turnPty.ts)), fires it from the two places that currently swallow PTY death ([src/phone/PhoneApp.vue:631](../../../src/phone/PhoneApp.vue) read pump, [`:640-657`](../../../src/phone/PhoneApp.vue) write queue), and has the runner drop a dead handle so the next `ensureOpen` genuinely reopens. Stage 1b (warm session + idle reaper) is **not in this plan** — its shape depends on Stage 0's gate verdict and it gets its own plan.

**Tech Stack:** Vue 3 + TypeScript, Capacitor (Android), Vitest (`scripts/run-js-unit-gate.sh`), `pnpm dev:live` browser dev mode ([docs/browser-dev-mode.md](../../browser-dev-mode.md)), PowerShell build script.

**Spec:** `docs/superpowers/specs/2026-11-03-pi-turn-warm-session-design.md`

---

## Plan-time findings that amend the spec

Three facts were verified while writing this plan. Each changes how a spec step must be executed; Task 6 writes the amendments into the spec.

### F1 — the spec's Stage 0 logcat channel does not work

Spec §4 Stage 0 step 1 says "Capture `[pi turn] send …` from the maintainer's phone over logcat". It cannot:

- `[pi turn]` is emitted with `console.debug` at [src/pi/piTurnRunner.ts:834](../../../src/pi/piTurnRunner.ts) and is the runner's **only** instrumentation sink.
- [capacitor.config.ts](../../../capacitor.config.ts) sets `loggingBehavior: 'none'`, with the reason recorded in-file: "the SSH connect call carries the private key, and debug builds are what we install for tests."
- Capacitor's `BridgeWebChromeClient.onConsoleMessage` forwards page console output through `Logger.info` / `Logger.debug`, and every `Logger` level is gated by `shouldLog()` → `config == null || config.isLoggingEnabled()` (`node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/Logger.java:100-102`). With `'none'`, `isLoggingEnabled()` is false, so **no page console output reaches logcat at all**.
- The gate cannot be narrowed. The bridge's own plugin-call logs (`%cresult %c` / `%cnative %c`, filtered out by `isValidMsg`) are what carries the key, but they share the same single `shouldLog()` gate as page logs. Flipping `loggingBehavior` to expose `[pi turn]` re-exposes plugin-call arguments with it.

**Do not change `loggingBehavior`.** Task 1 uses the browser console instead; Task 2 uses host-side SSH timing for the packaged-app number.

### F2 — the Docker fixture has no `pi` and no `tmux`

`tests/docker/` contains **zero** occurrences of `tmux` (verified by grep across the whole directory). [Dockerfile.agents](../../../tests/docker/Dockerfile.agents) is `FROM debian:trixie-slim`, installs `openssh-server openssh-client` (`:73-78`), pins the published `pocketshell==0.5.8` CLI and `aplexer==0.1.5` ([fixture-pins.txt:25-26](../../../tests/docker/fixture-pins.txt)), and `agent-bin/` holds only fake stubs (`claude`, `codex`, `opencode`, `quse`, `uv`, `pocketshell-fake-agent`). `buildPiOpenCommand` needs `tmux` and the runner needs `pi` on PATH.

So `pnpm dev:live -- --host testuser@127.0.0.1:2222=fixture` **cannot** exercise the turn path. This matches [docs/browser-dev-mode.md](../../browser-dev-mode.md), which already records that in live smoke mode "the real-PTY step is a deferred Plan 5 check". **Stage 0 requires a real host** with `pi` + `tmux` — the maintainer's `hetzner` box is the one their phone already uses. Extending the fixture with `pi`/`tmux` is out of scope here and would be a G6 trap anyway: boot timing of a stub is not boot timing of pi.

### F3 — `pnpm dev:live` runs the identical app code path

This is what makes F1 survivable. Verified:

- `PhoneApp.vue` is the single mount point (D45: only `src/main.ts` → `PhoneApp.vue`), and it installs the turn PTY opener **unconditionally**: `installTurnPtyOpener(turnPtyImplementation)` at [src/phone/PhoneApp.vue:304](../../../src/phone/PhoneApp.vue). There is no browser-specific substitute.
- `turnPtyImplementation` ([`:574-667`](../../../src/phone/PhoneApp.vue)) calls `sshCapability.openPty` / `readPty` / `writePty`, and in dev:live `SshCapability` is the bridge proxy, whose forwarded method list is exactly `'cancelScheduledClose', 'exec', 'openPty', 'readPty', 'writePty', 'resizePty', 'closePty', …` ([src/dev/browser/liveBridge.ts:13](../../../src/dev/browser/liveBridge.ts)).
- The bridge implements `eof` on the read path (`pty.eof` in the wait condition, [scripts/dev-ssh-bridge/bridge.mjs:630](../../../scripts/dev-ssh-bridge/bridge.mjs)), so it reports PTY death the same way the Android plugin does — which is what makes Task 1's reproduction attempt meaningful in the browser.

Therefore the same runner, the same `ComposerDeliveryController`, the same tmux commands and the same host all execute under dev:live. **What differs is only the transport underneath** (Node `ssh2` over a loopback WebSocket vs. the Android plugin over the phone's radio). Per-call round-trip latency is therefore *understated* in the browser relative to the phone.

**Why that does not invalidate the gate.** The gate question is "does `open + ready` dominate `deliver`?" The disputed quantity inside `open`/`ready` is pi's node-process boot — seconds — against `deliver`'s 250 ms fixed submit pause ([src/pi/piTurnRunner.ts:46](../../../src/pi/piTurnRunner.ts)). A transport constant of tens-to-hundreds of milliseconds cannot flip a seconds-vs-250 ms verdict. Task 2 independently measures the pi boot on the host, where transport is not in the number at all.

---

## Global Constraints

- **Implementers never commit, push, or close issues** ([process.md](../../../process.md)). Work happens in an isolated worktree off `origin/main`; the deliverable is a status comment plus the worktree path.
- **Stage 1a is a D22 hard cut.** No feature flag, no "legacy silent write" branch, no `keepAlive` option. `write` stops swallowing rejection in the same change that adds the death signal; the superseded silent behaviour is deleted, not deprecated.
- **`capacitor.config.ts` `loggingBehavior` is never modified.** See F1. Any plan step that appears to need it is wrong; use the browser console or host-side timing.
- **Never run `tmux kill-server`.** Not on the host, not in a probe, not even with `-L` — [AGENTS.md](../../../AGENTS.md) records that `TMUX_TMPDIR`/`-L` do not isolate it from the default socket. Kill by session name only: `tmux -L <socket> kill-session -t <name>`.
- **Never use the maintainer's default tmux socket.** Every host-side command in Task 2 uses the probe socket `ps-probe`, deliberately distinct from the app's `pocketshell-pi` ([src/pi/piTurn.ts:36](../../../src/pi/piTurn.ts)), so a mistake in a probe cannot touch a live turn.
- **Never put a `$` in an `rm`/`rmdir` target** — resolve the path in a separate call first, then delete with the literal path pasted in (AGENTS.md circuit-breaker note).
- **`vendor/pocketshell-core` stays frozen.** `git diff --stat -- vendor/` must be empty at every task boundary. Stage 1a needs nothing from core: `ComposerDeliveryController`'s `uncertain` return path already exists ([vendor/pocketshell-core/src/composerSend.ts:437-448](../../../vendor/pocketshell-core/src/composerSend.ts)).
- **Do not touch `submitDelayMs` (250 ms) or `PASTE_GAP_MS` (120 ms).** Spec §2 non-goals: these are measured values with a recorded 2026-09-22 experiment behind them ([composerSend.ts:88-95](../../../vendor/pocketshell-core/src/composerSend.ts)).
- **Do not implement Stage 1b.** No warm-session retention, no idle reaper, no change to `reconcilePendingTurns`, no change to `buildPiCloseCommand`. The kill-on-answer at [src/pi/piTurnRunner.ts:752-773](../../../src/pi/piTurnRunner.ts) stays exactly as it is in this plan.
- **D44's regression net must stay green unchanged.** The reconnect / grace / adoption / `has-session` journeys are the proof this did not disturb the subsystem D28 calls the most critical. If a D44 test needs editing to pass Stage 1a, stop and report — that is a design problem, not a test problem.
- **Unit gate:** `scripts/run-js-unit-gate.sh`. **Typecheck:** `pnpm typecheck`. Both green at every task boundary.
- **Test manifest (G9):** every new or renamed test title must be registered in [scripts/js-unit-test-manifest.json](../../../scripts/js-unit-test-manifest.json) under its file's `{suite, tests[]}` entry, or the gate fails. `piTurnRunner.test.ts`'s entry is at `:1507`.
- **Docs are written in English.** The maintainer may dictate in Russian; translate in-thread and write English artifacts.
- Build the APK with `scripts/build-android-debug.ps1` (this is a Windows box), after `git submodule update --init --recursive` and `pnpm install --frozen-lockfile`.

---

### Task 1: Stage 0 — measure the send path against a real host in the browser

**Files:**
- Create: `build/pi-turn-stage0/devlive-timings.md` (scratch evidence, **not committed** — `build/` is gitignored; the numbers get pasted into the issue comment and into the spec amendment in Task 6)
- Modify: none (measurement only)
- Test: none

**Interfaces:**
- Consumes: a real host with `pi` + `tmux` on PATH and an SSH key the maintainer authorises for this measurement; `pnpm dev:live` per [docs/browser-dev-mode.md](../../browser-dev-mode.md).
- Produces: the `[pi turn] send open=… ready=… baseline=… deliver=… adopt=… total=…` triples that Task 2 cross-checks and Task 7 reports, plus a yes/no on whether spec §3.2's predicted silent loss reproduces.

- [ ] **Step 1: Confirm the host has what the turn path needs**

Over the maintainer's own SSH (not through the app):

```bash
ssh <host> 'command -v pi; command -v tmux; pi --version'
```

Both must resolve. **Decision rule:** if either is missing, this task is `BLOCKED` on host setup — do not substitute the Docker fixture (F2) and do not fake a `pi`. Record the resolved paths and the version string in the evidence file; the version matters because pi was renamed `@mariozechner/` → `@earendil-works/` and its surface moves (spec §5B.3).

- [ ] **Step 2: Start dev:live with tracing**

```bash
git submodule update --init --recursive && pnpm install --frozen-lockfile
pnpm dev:live -- --host <user>@<host>[:<port>]=stage0 --identity <key path>
```

Use `--identity`, **never** the in-page Manage-keys import: [docs/browser-dev-mode.md](../../browser-dev-mode.md) records that the import path reads the key file in JavaScript and sends its text to the bridge, so the bytes pass through the browser tab.

Open the printed `http://127.0.0.1:5173/#devBridgeToken=…` URL, then append `?devTrace=1` (keeping the fragment) so each SSH call's method, command and outcome code is logged. In Chrome/Edge press Ctrl+Shift+M and pick a phone profile (412 × 915). Leave DevTools' Console open and **preserve log** enabled — the send spans several seconds and a navigation would otherwise clear it.

**Expected:** the connections tab lists `stage0`; the first connect shows the real host-key trust prompt (this is a genuine handshake, not the mock's fixed key).

- [ ] **Step 3: Capture the three timings the gate needs**

In one conversation, without leaving the chat screen:

1. **First message.** Send a short line. Copy the whole `[pi turn] send …` line.
2. **Second message in the same conversation.** Send another short line. Copy the line.
3. **Multi-line message.** Send a message with at least three lines (this is the path that pays `PASTE_GAP_MS` twice). Copy the line.

Repeat 1–3 once more so each number has a second sample, and note whether the numbers are stable or noisy. Also record the `devTrace` per-call durations for the `openPty`, `readPty` and `exec` calls inside one send, so the transport share of `open` is visible separately from the host share.

**Decision rule for what counts:** a capture is only usable if the turn actually answered (the reply rendered). A send that errored, or one where pi asked for authentication/model selection, is not a timing sample — record what happened instead and retry. Do not average a failed send into the numbers.

- [ ] **Step 4: Attempt the §3.2 silent-loss reproduction**

Spec §3.2 predicts: the second message in an on-screen conversation is written into a PTY whose tmux session the first turn's kill already destroyed, the bubble reports sent, and the poll runs to the ten-minute deadline.

In the same conversation as Step 3, watch for it specifically:

- does the second send's `[pi turn]` line show `open=0` (i.e. `ensureOpen` early-returned on the stale handle, [src/pi/piTurnRunner.ts:455-460](../../../src/pi/piTurnRunner.ts)) and `ready=0` (`waitForReady` early-returned on `state.ready`, [`:531-534`](../../../src/pi/piTurnRunner.ts))?
- does the reply actually render, or does the spinner run past any plausible pi response time?
- does the console show a `devTrace` `writePty` failure that the UI did not surface?

Do not wait ten minutes. **Decision rule:** if the second send has not answered within ~90 s, call it a reproduction, capture the console and the host-side `tmux -L pocketshell-pi list-sessions` output at that moment, and stop. If it *does* answer, that refutes the prediction and **why it answers is a required finding** — capture the `[pi turn]` line and the host-side session list immediately after the first turn settles, and determine from them whether the kill actually landed, whether the PTY actually hit EOF, or whether `ensureOpen` reopened for a reason not visible in the code reading. Record whichever explanation the evidence supports; do not speculate in the evidence file.

This step's outcome does not gate Stage 1a (spec §6.1: it ships regardless, because a write into a dead channel that reports `delivered` is a hazard independent of latency). It does gate **Task 3's red test**: if the symptom does not reproduce, Task 3 must be re-briefed to write the red test against whatever the real mechanism turned out to be, rather than against a prediction.

- [ ] **Step 5: Record the process-count baseline**

Spec §9's highest-ranked risk is orphaned pi processes. Capture the baseline now so Stage 1b can be compared against it:

```bash
ssh <host> 'tmux -L pocketshell-pi list-sessions 2>/dev/null | wc -l; pgrep -c -f "pi" '
```

**Never** `tmux kill-server` to reset this, even with `-L` (Global Constraints). If the count needs clearing, kill by name.

- [ ] **Step 6: Write the evidence file and post it**

`build/pi-turn-stage0/devlive-timings.md`: host (redacted to the alias), pi version, the six `[pi turn]` lines verbatim, the `devTrace` breakdown for one send, the §3.2 verdict with its supporting evidence, and the process-count baseline. Then post the same content as a comment on the Stage 0 issue.

---

### Task 2: Stage 0 — host-side cross-check and the gate verdict

**Files:**
- Create: `build/pi-turn-stage0/host-boot-timing.md` (scratch, not committed)
- Modify: none
- Test: none

**Interfaces:**
- Consumes: Task 1's browser timings; SSH access to the same host.
- Produces: the **gate verdict** that decides whether Stage 1b is ever planned, and the pi-boot number that is transport-independent.

Task 1's numbers carry a browser transport constant (F3). This task measures the disputed quantity — pi's cold boot — directly on the host, where no transport is in the number.

- [ ] **Step 1: Time a cold pi boot under tmux on the probe socket**

```bash
ssh <host> 'S=ps-probe; N=stage0-boot
  tmux -L $S kill-session -t $N 2>/dev/null
  START=$(date +%s%3N)
  tmux -L $S new-session -d -s $N -x 100 -y 30 "pi"
  for i in $(seq 1 600); do
    if tmux -L $S capture-pane -p -t $N | grep -q .; then break; fi
    sleep 0.1
  done
  READY=$(date +%s%3N)
  echo "cold boot to first painted output: $((READY-START)) ms"
  tmux -L $S kill-session -t $N'
```

`date +%s%3N` is GNU-specific; the host is Linux (Hetzner, RMTHZ). The probe socket `ps-probe` is deliberately **not** `pocketshell-pi`.

**Note on what this measures:** `capture-pane -p` yields screen contents, not the byte stream, so the app's real readiness signal `PI_INPUT_READY_MARKER = '\x1b[?2004h'` ([src/pi/turnReadiness.ts:14](../../../src/pi/turnReadiness.ts)) is **not** observable this way — a mode-set escape never lands in the pane text. This probe therefore measures boot-to-first-painted-output, which is a *lower bound* on the app's `ready`. Say so in the evidence file; do not present it as the same quantity.

- [ ] **Step 2: Time the warm attach for comparison**

```bash
ssh <host> 'S=ps-probe; N=stage0-warm
  tmux -L $S new-session -d -s $N -x 100 -y 30 "pi"
  sleep 20
  START=$(date +%s%3N)
  tmux -L $S new-session -d -s attach-probe "tmux -L $S attach-session -d -t $N; exit"
  sleep 2
  END=$(date +%s%3N)
  tmux -L $S capture-pane -p -t $N | head -5
  echo "warm attach window: $((END-START)) ms"
  tmux -L $S kill-session -t $N 2>/dev/null
  tmux -L $S kill-session -t attach-probe 2>/dev/null'
```

This is the shape Stage 1b would make every message after the first look like: the session already exists, so `buildPiOpenCommand`'s `attach-session -d -t NAME ||` branch wins and no pi boots ([src/pi/piTurn.ts:129-161](../../../src/pi/piTurn.ts)).

- [ ] **Step 3: Reconcile with Task 1 and record the gate verdict**

Compare: (Step 1's cold boot) against (Task 1's second-message `open + ready`, minus the transport share `devTrace` exposed). They should agree within the transport constant. If they disagree by more than roughly that, say which measurement is wrong and why before proceeding — an unexplained disagreement means one of the two channels is not measuring what this plan assumes.

**Gate (spec §4 Stage 0):**

- `open + ready` dominates `deliver` on the second message → **PROCEED**. Stage 1b gets its own plan; the premise is evidence.
- `deliver` dominates → **STOP AND REPLAN.** The premise is wrong; the follow-up is about the pacing sleeps, not session lifetime, and that needs its own evidence burden (spec §2 non-goals). Do not build the reaper.
- The §3.2 symptom did not reproduce and no mechanism explains why → **Stage 1a proceeds, Stage 1b is held** until the mechanism is understood, because retaining a session whose death behaviour is unexplained is not a safe change.

Write the verdict, the two numbers and the reconciliation into `build/pi-turn-stage0/host-boot-timing.md` and post it to the Stage 0 issue. **Clean up every probe session by name** before finishing (the commands above already do; verify with `tmux -L ps-probe list-sessions` returning nothing).

---

### Task 3: Stage 1a red — make the harness model session death

**Files:**
- Modify: `tests/unit/piTurnRunner.test.ts`
- Modify: `scripts/js-unit-test-manifest.json` (new/changed titles)
- Test: the red test itself

**Interfaces:**
- Consumes: Task 1 Step 4's verdict (the mechanism the red test must reproduce).
- Produces: a harness whose fake PTY can die, and a failing test that pins spec §3.2's silent loss. This is D33/G10's reproduce-first step: **the test lands red before any product code changes.**

Spec §3.3 names the defect in the harness: `closeSession = vi.fn(async (_sessionName) => undefined)` at [tests/unit/piTurnRunner.test.ts:108](../../../tests/unit/piTurnRunner.test.ts) does nothing, so the fake handle outlives the session it belongs to and `'reuses the same handle for a later send after the first turn completes'` (`:288-298`) asserts a behaviour impossible on a real host. That is the G6 shape — a green structural proxy over an absent behaviour assertion.

- [ ] **Step 1: Give `FakeHandle` a death signal**

`TurnPtyHandle` ([src/session/turnPty.ts:14-21](../../../src/session/turnPty.ts)) is currently `{ onData, write, close }`. Add the close-listener set to the fake now, so Task 4's interface change has somewhere to land and the fake can be killed today:

```ts
interface FakeHandle extends TurnPtyHandle {
  writes: string[];
  write: ReturnType<typeof vi.fn>;
  emit(chunk: string): void;
  /** Model the host killing the tmux session: the channel dies. */
  kill(): void;
  killed: boolean;
  unsubscribe: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
```

In `fakeHandle` (`:33-57`), keep a `closeListeners: Set<() => void>` alongside the existing `listeners`, implement `kill()` to set `killed = true` and notify them, and make `write` throw when `killed` — a dead channel rejects input, which is what the real `writePty` does. `kill()` must be idempotent.

**Do not add `onClose` to the returned object yet** — `TurnPtyHandle` does not declare it until Task 4, and adding it here would make the fake satisfy an interface that does not exist. Task 3's red test asserts on *outcomes* (`openPty` call count, the send's `ok`, the writes recorded), not on the runner having subscribed.

- [ ] **Step 2: Make `closeSession` kill the session's handle by default**

Reality: the runner's `deps.closeSession` runs `tmux -L pocketshell-pi kill-session` ([src/pi/piTurn.ts:164-170](../../../src/pi/piTurn.ts)), which ends the attach, which EOFs the PTY ([src/pi/piTurn.ts:154-157](../../../src/pi/piTurn.ts) appends `exit;` for exactly that reason). The harness must model that:

```ts
const closeSession = vi.fn(async (_sessionName: string) => {
  if (options.killOnClose !== false) for (const h of handles) h.kill();
});
```

**`killOnClose` defaults to killing.** Modelling reality is the default and the opt-out is the exception, so an unrelated test cannot silently inherit the old lie. Add `killOnClose?: boolean` to the `harness` options object (`:71-80`) with a docstring saying why the default is what it is.

- [ ] **Step 3: Enumerate and justify every opt-out**

Run the suite and collect every test that now fails *because the harness models death* rather than because of a real defect. For each, decide:

- **The test's subject is unrelated to PTY lifetime** (a dialog-settle timing, a slash-command branch, a poll predicate) → pass `killOnClose: false` and add a one-line comment naming what the test is actually about.
- **The test's subject is reuse across sends** → it must be rewritten (Step 4), not opted out.

**Every use of `killOnClose: false` must be listed in the status comment with its justification.** An unexplained opt-out is how the original lie survived: the reviewer checks this list, not just the green run.

- [ ] **Step 4: Rewrite the reuse test and land the red test**

Replace `'reuses the same handle for a later send after the first turn completes'` (`:288-298`) with the two honest halves, per spec §8:

```ts
it('reopens the PTY when the first turn killed its session', async () => { … });
```
→ after the first send settles and `closeSession` fires, the second send must produce a second `openPty` call, and the writes must land on the *new* handle (`h.handles[1].writes`), not the dead one. Use `freshHandles: true` so the reopen is visible (`:78-92`).

```ts
it('reports a failure, not a sent line, when the turn PTY died before delivery', async () => { … });
```
→ kill the handle, then send. The send must not resolve `{ ok: true }`.

**Watch both fail red.** The first fails because `ensureOpen` early-returns on the stale non-null `open`; the second fails because nothing observes the death and the write's rejection is swallowed. Capture both failure messages verbatim for the status comment — that capture *is* the G1/G10 artifact.

If Task 1 Step 4 refuted the prediction, the second test's shape changes to match the mechanism Task 1 actually found. Re-brief before writing it; do not force a refuted prediction into a test.

- [ ] **Step 5: Register the titles (G9)**

Update `piTurnRunner.test.ts`'s entry in [scripts/js-unit-test-manifest.json:1507](../../../scripts/js-unit-test-manifest.json): remove the deleted title, add the two new ones exactly as written. Then:

```bash
scripts/run-js-unit-gate.sh
```

**Expected:** the gate runs the file and reports the two new tests failing. A gate failure about an *unregistered* title is a manifest bug — fix the manifest, never weaken the gate.

- [ ] **Step 6: Confirm nothing else moved**

```bash
pnpm typecheck
git diff --stat -- vendor/    # must be empty
```

The D44 journeys (reconnect / grace / adoption / `has-session`) must be untouched and green. **If any of them needed `killOnClose: false` to pass, stop and report** — that means a D44 guarantee is currently held up by the harness's inability to model death, which is a finding for the spec, not something to paper over in a test option.

---

### Task 4: Stage 1a green — PTY death becomes observable

**Files:**
- Modify: `src/session/turnPty.ts` (the interface)
- Modify: `src/phone/PhoneApp.vue` (the read pump and the write queue)
- Modify: `src/pi/piTurnRunner.ts` (subscribe to death, drop the handle)
- Test: Task 3's two red tests go green

**Interfaces:**
- Consumes: Task 3's red harness.
- Produces: `TurnPtyHandle.onClose`, and a runner that reopens instead of writing into a corpse.

- [ ] **Step 1: Extend the interface**

[src/session/turnPty.ts:14-21](../../../src/session/turnPty.ts):

```ts
export interface TurnPtyHandle {
  onData(callback: (chunk: string) => void): () => void;
  /**
   * Fires once when the channel dies — the far end closed, a write was
   * rejected, or the read pump hit EOF. A handle that has fired this must
   * never be written into again.
   */
  onClose(callback: () => void): () => void;
  write(data: string): void;
  close(): void;
}
```

`write` **stays synchronous**. Awaiting `writePty` would add a round trip per write to a path whose whole complaint is latency — a regression on the thing being fixed. The death signal, not the return value, is how a failed write is reported.

- [ ] **Step 2: Fire close from the read pump**

[src/phone/PhoneApp.vue:631](../../../src/phone/PhoneApp.vue) is `if (result.eof) return;` — the pump stops with no notification. Also fire on the pump's error/stale-response exits, not only on a clean EOF: a channel that stops answering is dead for the runner's purposes even when it never sent a FIN. Fire exactly once (guard with the same `closed` flag the write path uses) and make sure `close()` does not double-fire it.

- [ ] **Step 3: Stop swallowing the write rejection**

[src/phone/PhoneApp.vue:640-657](../../../src/phone/PhoneApp.vue) ends `}).catch(() => undefined);`, discarding the "发送通道拒绝了输入。" error. Keep the queue shape (it exists so two writes never race their sequence) but fire close on rejection instead of discarding it.

**Do not** make `write` rethrow synchronously to the caller as well: `ComposerDeliveryController` already has an `uncertain` path for a write that may or may not have landed ([vendor/pocketshell-core/src/composerSend.ts:437-448](../../../vendor/pocketshell-core/src/composerSend.ts)), and the runner reaching `dropTurn()` via `onClose` is what makes the *next* send honest. Adding a second, synchronous failure route for the same event is the kind of duplicate signal that makes a delivery outcome ambiguous.

- [ ] **Step 4: Drop the dead handle in the runner**

In `ensureOpen` ([src/pi/piTurnRunner.ts:455-503](../../../src/pi/piTurnRunner.ts)), where the handle is created and `open` is assigned (`:499`), subscribe:

```ts
handle.onClose(() => { if (open?.handle === handle) dropTurn(); });
```

The identity check matters: a late close from a superseded handle must not drop the live one. `unsubscribeActive()` in `dropTurn` (`:505-518`) already handles the data subscription; add the close subscription to the same teardown so a dropped handle cannot fire into a runner that has moved on.

**`dropTurn()` must not abort an in-flight run, and it does not.** It clears `open` / `openSessionFile`, unsubscribes and closes the handle — it never touches `run`. `pollForReplies` reads the session file through `watchSession` / `readSession`, not through the PTY, so a turn already in flight keeps being polled after its PTY dies. **That is D44 and it must stay that way**: the whole point of the tmux design is that the phone's channel dying does not stop the turn. Verify this explicitly in a test (Task 5), not by reading.

- [ ] **Step 5: Watch the red tests go green, and record the residual race**

```bash
scripts/run-js-unit-gate.sh && pnpm typecheck
```

Both Task 3 tests green. Then write into the status comment the race this change **accepts** rather than closes:

> A death notification arriving in the same tick *after* the final `SUBMIT_KEY` write still leaves `deliverOne` returning `delivered`. Closing it fully needs a `failIfStale()` before that return in `vendor/pocketshell-core/src/composerSend.ts`, which spec §2's non-goals exclude (core is frozen). The accepted exposure is one turn, reported sent, whose reply poll then times out — bounded, and strictly narrower than today's every-second-message.

Stating the residual is required. A reviewer who finds it unstated cannot tell whether it was missed or judged.

- [ ] **Step 6: Confirm the freeze and the D44 net**

```bash
git diff --stat -- vendor/    # must be empty
```

Re-run the D44 journeys. They must pass **without edits**.

---

### Task 5: Stage 1a class coverage (G2)

**Files:**
- Modify: `tests/unit/piTurnRunner.test.ts`
- Modify: `scripts/js-unit-test-manifest.json`
- Test: one test per class below

**Interfaces:**
- Consumes: Task 4's green implementation and Task 3's killable harness.
- Produces: the G2 class coverage spec §8 requires — not just the one reported instance.

Each class is a test. Each title goes in the manifest.

- [ ] **Step 1: EOF mid-turn**

The handle dies *while* a turn is in flight (after delivery, before the reply lands). Assert: the run is **not** aborted, the poll continues on the session file, and the turn still resolves `ok` when the file answers. This is the D44 guarantee from Task 4 Step 4, pinned.

- [ ] **Step 2: Write rejected by the channel**

`writeError` already exists in the harness (`:33-57`) but models a *synchronous throw*. Reality is an async rejection inside the queue that gets swallowed. Add a fake mode that rejects the write through the `onClose` route rather than by throwing, and assert the send does not report success. **Note the shape difference in a comment** — a test that models the wrong failure shape is how `writeError` coverage existed while the real bug survived.

- [ ] **Step 3: Host reboot between sends**

First send answers, the session is killed, and the *reopened* PTY also dies (model: kill the second handle too). Assert the third send still opens a fresh handle and can succeed — i.e. the runner recovers repeatedly, not once.

- [ ] **Step 4: pi crashing on its own**

The handle dies with no `closeSession` call — nothing the runner did caused it. Assert the same recovery, and assert `closeSession` was **not** invoked for it (the runner must not claim a teardown it did not perform; that distinction is what keeps spec §3.4's record bookkeeping honest).

- [ ] **Step 5: A `restartPending` command superseding the PTY**

The existing path must keep working: `dropTurnIfSuperseded` ([src/pi/piTurnRunner.ts:527-529](../../../src/pi/piTurnRunner.ts)) fires when a takeover command set `state.restartPending = true` ([`:1009`](../../../src/pi/piTurnRunner.ts)). Assert a takeover still drops and reopens, and that a *death* and a *takeover* in the same sequence do not double-drop or leave `open` pointing at a corpse.

- [ ] **Step 6: Gate and manifest**

```bash
scripts/run-js-unit-gate.sh && pnpm typecheck
```

Confirm every new title is registered and that the gate reports a test count greater than zero for the file (G3).

---

### Task 6: Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-11-03-pi-turn-warm-session-design.md`
- Modify: `docs/lessons-learned.md`
- Modify: `docs/browser-dev-mode.md`
- Test: none (docs-only; `pnpm typecheck` as a no-op sanity check)

**Interfaces:**
- Consumes: Tasks 1–5 finished, with the gate verdict in hand.
- Produces: the recorded text Task 7's reviewer and the commit message cite.

- [ ] **Step 1: Amend the spec with F1, F2, F3 and the verdict**

Spec §4 Stage 0 step 1 currently says "over logcat". Replace it with the browser-console channel and the reason logcat is unavailable (`loggingBehavior: 'none'` + `Logger.shouldLog()`), stating plainly that flipping it is forbidden because the same gate protects the private key. Add the F2 finding (no `pi`/`tmux` in the Docker fixture, so Stage 0 needs a real host) and F3 (dev:live runs the identical code path, with the transport caveat). Change §3's header from "**not** yet verified on device" to reflect what Task 1 actually established, and record the §3.2 verdict — confirmed or refuted, with the mechanism. Append the gate verdict from Task 2 Step 3 and what it authorises.

If the gate said **STOP AND REPLAN**, the spec's `Status:` becomes `Closed — premise refuted` and §7's D44 amendment does not happen (spec §7 already says exactly this). Stage 1a's docs still land, per spec §6.1.

- [ ] **Step 2: `docs/lessons-learned.md` — the G6 instance**

Add the spec §3.3 shape as a durable lesson: a reuse test whose double *cannot* die stays green over a behaviour impossible on the host. Name the two tells — the fixture's teardown callback is a no-op `vi.fn`, and the assertion counts calls instead of asserting where the bytes landed. Cross-ref G6 and the manifest. Read [docs/documentation-guide.md](../../documentation-guide.md) before restructuring anything; add the entry, do not reorganise the file.

- [ ] **Step 3: `docs/browser-dev-mode.md` — what live mode is authoritative for**

The doc currently frames dev:live as "for UI work and quick checks. It is not acceptance evidence." That is still true for *acceptance*, but Stage 0 just used it as a **measurement** channel for a real-host latency question, which the doc does not currently address. Add a short subsection recording: dev:live runs the identical app code path including `turnPtyImplementation` (F3's three citations), its transport differs from the phone's so per-call latency is understated, and therefore it is valid for host-side cost comparisons and invalid as a packaged-app latency number. Also record that `loggingBehavior: 'none'` means the APK exposes no page console output at all, so the browser console is the only place `[pi turn]` can be read.

- [ ] **Step 4: Do not touch `docs/decisions.md` yet**

The D44 amendment (spec §7) belongs to **Stage 1b**, because it changes when a session is killed. Stage 1a changes no lifetime rule. Leave D44 alone in this plan and say so in the status comment, so the reviewer does not read the omission as a miss.

- [ ] **Step 5: Sanity**

```bash
pnpm typecheck && scripts/run-js-unit-gate.sh
```

---

### Task 7: Full verification, APK, and process hand-off

**Files:** none created; runs the checks and produces the APK.

**Interfaces:**
- Consumes: Tasks 1–6 complete.
- Produces: the evidence bundle for the reviewer and the maintainer.

- [ ] **Step 1: Full local verification**

```bash
git status --short             # only expected modifications; no build/ artifacts tracked
git diff --stat -- vendor/     # must be empty
scripts/run-js-unit-gate.sh && pnpm typecheck
```

Confirm the Task 3 red captures and the Task 4 green run are both quoted in the status comments — the reviewer must see red→green from *this* run (G1), not a claim that it happened.

- [ ] **Step 2: Build the debug APK**

```powershell
git submodule update --init --recursive
pnpm install --frozen-lockfile
scripts/build-android-debug.ps1
```

Record the APK path, `versionName (versionCode)` from the build output, and its SHA-256 (`Get-FileHash -Algorithm SHA256 <apk>`).

- [ ] **Step 3: The on-phone check that this change is real**

The unit gate proves the runner reopens. It does not prove the phone's second message lands. Hand the maintainer the APK and ask for one specific observation, per [AGENTS.md](../../../AGENTS.md)'s "a testable debug APK comes before every commit":

> In one conversation, send a message, wait for the reply, then send a second message without leaving the chat. Does the second one get answered?

That is the felt symptom, and it is the only acceptance that matters for Stage 1a. Note in the hand-off that spec §9 warns this change may turn a previously-silent failure into a **visible** one: a send that used to report delivered and quietly time out can now report a failure. That is the point, not a regression, but the maintainer should expect it in the first day.

- [ ] **Step 4: Report for review**

Report (task comment / issue comment): the Stage 0 numbers and gate verdict, the `killOnClose: false` opt-out list with justifications, the red→green captures, the residual race from Task 4 Step 5, deleted/modified file totals, gate + typecheck output tails, and the APK path/version/sha256.

Per [process.md](../../../process.md) the orchestrator then dispatches a reviewer (emulator evidence per [docs/review-standards.md](../../review-standards.md) — this is user-facing chat work), and only after APPROVED plus the maintainer's on-phone verdict does the orchestrator commit.

---

## Self-Review (done at plan time)

- **Spec coverage:** §4 Stage 0 steps 1–2 → Tasks 1–2; §4 Stage 0 gate → Task 2 Step 3; §3.2 predicted symptom → Task 1 Step 4 + Task 3 Step 4; §3.3 harness defect → Task 3 Steps 1–4; §4 Stage 1a items 1–4 → Task 4 Steps 1, 2, 3, 4 respectively; §6.1 (1a ships regardless) → Task 1 Step 4's closing paragraph; §6.6 (harness models death before review) → Task 3 precedes Task 4; §8 harness-first + G2 class list → Tasks 3, 5 (all five classes, including the `restartPending` one); §8 D44 regression net → Task 3 Step 6, Task 4 Step 6, Task 5 Step 1; §8 gates + before/after acceptance → Task 7; §9 orphan-risk baseline → Task 1 Step 5; §9 visible-failure risk → Task 7 Step 3; §7 docs → Task 6, with the D44 amendment deliberately deferred to Stage 1b (Task 6 Step 4). **§4 Stage 1b and §5C are intentionally absent** — 1b is gated on Task 2's verdict and gets its own plan; the RPC spike is a separate read-only researcher issue. No unintentional gap found.
- **Placeholders:** none in the executable steps. `<host>`, `<user>`, `<key path>` in Task 1 Step 2 and `<host>` in Task 2 are values only the maintainer can supply (an SSH identity this plan must not guess or generate); every other command is literal. The `killOnClose` opt-out set in Task 3 Step 3 is enumerated by a decision rule, not left open.
- **Type consistency:** `FakeHandle`'s `kill()` / `killed` (Task 3 Step 1) and `TurnPtyHandle.onClose` (Task 4 Step 1) are introduced in that order on purpose — the fake gains the *capability* to die while the interface still lacks the *signal*, which is what makes Task 3's test assert on outcomes rather than on a subscription that does not exist yet. Task 4 Step 4's `open?.handle === handle` identity guard matches the `open` record shape assigned at `src/pi/piTurnRunner.ts:499`. `write` stays `void`-returning in both the interface and the fake; no step makes it async.
- **Verification of every citation:** all file:line references in this plan were re-checked against the working tree while writing it. Three earlier spec citations had been wrong and were fixed before the spec was handed over; the plan-time checks additionally produced F1–F3, which contradict spec §4 Stage 0's channel and are carried as amendments in Task 6 Step 1 rather than being quietly worked around.
