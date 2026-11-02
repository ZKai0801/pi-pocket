# Pi turn delivery: make the warm PTY actually warm, and stop paying a pi cold start per message

- **Date:** 2026-11-03
- **Status:** Draft for maintainer review. Stage 0 is measured (§4) and its gate
  said PROCEED; Stage 1a is implemented and unit-proven, pending review and the
  phone dogfood; Stage 1b (warm session + idle reaper) is not started and gets
  its own plan.
- **Origin:** Maintainer report in conversation, 2026-11-02 — after testing
  [`jacobaraujo7/remote_pi`](https://github.com/jacobaraujo7/remote_pi) (cloned
  to `D:\projects\remote_pi` for this analysis), "它发送消息的速度要远快于本项目，
  这是为什么？它连接 pi 的技术路径是什么？我们是否可以借用". The comparison
  analysis in that conversation is the input; this spec is the actionable half
  of it. Nothing here is committed to borrowing remote_pi's architecture —
  §5 records why we are not.

## 1. Context and motivation

Every message the phone sends currently pays for a **cold `pi` process**.

The turn runner kills the conversation's tmux session the moment a turn is
answered ([`src/pi/piTurnRunner.ts:766`](../../src/pi/piTurnRunner.ts) →
`deps.closeSession` → [`src/pi/piTurn.ts:168`](../../src/pi/piTurn.ts),
`tmux -L pocketshell-pi kill-session`). The next message in the same
conversation therefore re-runs `ensureOpen`: open an SSH PTY channel → `tmux
new-session` → **boot `pi` from zero** → `waitForReady` (deadline 20 s,
[`src/pi/piTurnRunner.ts:341`](../../src/pi/piTurnRunner.ts)) → read the
session file for the assistant baseline (another round trip) → only then write
the first byte.

That is the design `buildPiCloseCommand`'s own docstring chose deliberately:

> Pi's TUI would otherwise sit idle in a session nobody looks at, one node
> process per conversation ever opened.
> — [`src/pi/piTurn.ts:164-166`](../../src/pi/piTurn.ts)

The trade was "no orphan processes" against "a cold start per message". The
maintainer has now felt the other side of that trade by comparison with a
client that never pays it.

### 1.1 Why remote_pi does not pay it

remote_pi delivers a message with an **in-process function call** on pi's
extension API:

```ts
_pi.sendUserMessage(content, { deliverAs: 'steer' | 'followUp' })
```

[`pi-extension/src/index.ts:4079`](file:///D:/projects/remote_pi/pi-extension/src/index.ts).
No PTY, no terminal escape parsing, no pacing sleeps, and a synchronous throw
is the rejection path — which is why its ACK is a field (`received` / `busy` /
`denied` / `timeout`) rather than an inference. Its `deliverAs` enum maps 1:1
onto the `intent` our composer already has; we synthesise the same two
outcomes from keystrokes (`\r` vs. Alt+Enter,
[`src/pi/piTurnRunner.ts:673-684`](../../src/pi/piTurnRunner.ts)).

Replies come back as pi's own structured events — `pi.on('turn_start' |
'turn_end' | 'agent_start' | 'agent_end' | 'message_update' |
'tool_execution_end' | …)`,
[`index.ts:2172-2309`](file:///D:/projects/remote_pi/pi-extension/src/index.ts).
**The three-part predicate D44 had to grow (assistant count AND settled tail
AND final stop reason) is one `turn_end` event there.**

The process stays warm because its lifetime is decoupled from the client's
connection: pi runs on a desktop under a supervisor daemon installed as a
systemd-user / launchd service, and the phone reaches it through a WebSocket
relay, not SSH.

### 1.2 What this spec does about it

Borrowing the *transport* is rejected (§5). Borrowing the *property* — a warm
pi process that does not restart per message — is compatible with D44 and D45
and needs nothing installed on the host. That is Stage 1.

Getting there safely requires fixing a correctness hazard first (§3.2), which
is Stage 0's second half and is worth shipping on its own merits.

## 2. Goals and non-goals

**Goals**

1. **Measure before changing anything.** Produce real `[pi turn] send
   open=… ready=… baseline=… deliver=… total=…` numbers from the maintainer's
   phone for (a) a first message in a conversation and (b) a second message
   in the same conversation, so the premise of this spec is evidence and not
   a code reading (D33/G10 reproduce-first).
2. **Make PTY death observable.** A turn PTY whose tmux session is gone must
   never be written into. Today nothing detects it (§3.2).
3. **Stop the per-message cold start** for a conversation the user is actively
   in, without letting pi processes accumulate unboundedly on the host.
4. Keep every D44 guarantee intact: a turn survives disconnect, grace expiry,
   host switch, and the app being killed; a turn that still owes work is
   adopted, never killed; a pane this phone never delivered is never killed.

**Non-goals**

- **No change to `submitDelayMs` (250 ms) or `PASTE_GAP_MS` (120 ms).** These
  are measured values, not guesses — the comment at
  [`vendor/pocketshell-core/src/composerSend.ts:88-95`](../../vendor/pocketshell-core/src/composerSend.ts)
  records a 2026-09-22 measurement (40 ms loses the paste head, 60 ms
  survives, one 80 ms run still failed). Narrowing them needs its own
  evidence and its own change.
- **No pi extension, no relay, no supervisor daemon on the host.** D45's host
  contract stays "SSH + `pi`, tmux recommended".
- **No `pi --mode rpc`.** Recorded as a follow-on research spike (§5, option
  C), explicitly not part of this change.
- No change to `vendor/pocketshell-core` beyond what the delivery controller's
  existing options already allow.
- No change to the reconnect/grace ladder, the session cache, or the chat
  rendering path.

## 3. Current state (as of `754b4245`; code reading verified 2026-11-03 **and confirmed by observation over `dev:live` against a real host** — see §3.2's verdict and §4 Stage 0)

The line numbers below are that tree's, before Stage 1a landed; Stage 1a's own
section cites the post-change lines. §3.2's mechanism is written in the present
tense because it describes the tree this spec was written against — the four
early-return/swallow paths are what Stage 1a removes, and item by item §3.1,
§3.4 and §3.5 are unaffected by it.

### 3.1 The teardown/reuse contradiction

Two pieces of the design disagree, and the disagreement is currently invisible
because the test double cannot express it.

- The **facade intends to keep a warm PTY**: on settlement it releases the
  runner only when the chat has left the screen —
  > Keep the warm PTY only for the chat that is still on screen; a turn that
  > finished in the background gives its runner back.

  [`src/stores/sessions.ts:2204-2207`](../../src/stores/sessions.ts). A draft
  always releases ([`:2236`](../../src/stores/sessions.ts)).
- The **runner kills the session behind that PTY** on answer
  ([`src/pi/piTurnRunner.ts:752-773`](../../src/pi/piTurnRunner.ts)), and
  `completeTurn` does not dispose the runner
  ([`src/stores/sessions.ts:1149-1178`](../../src/stores/sessions.ts)).
- The kill ends the tmux client, so the attach command returns and the PTY
  hits EOF — `buildPiOpenCommand` appends `exit;` for exactly that reason
  ([`src/pi/piTurn.ts:154-157`](../../src/pi/piTurn.ts)).

Net effect for a conversation kept on screen: the runner holds a handle to a
**dead** channel, and the next send reuses it.

### 3.2 Nothing observes PTY death

- `ensureOpen` early-returns on a non-null `open`
  ([`:455-460`](../../src/pi/piTurnRunner.ts)).
- `waitForReady` early-returns on `state.ready === true`, which was set during
  the *first* turn ([`:531-534`](../../src/pi/piTurnRunner.ts), set in
  `subscribe` at [`:384-391`](../../src/pi/piTurnRunner.ts)).
- The read pump simply stops on EOF with no callback to the runner:
  `if (result.eof) return;`
  ([`src/phone/PhoneApp.vue:631`](../../src/phone/PhoneApp.vue)).
- `handle.write` is fire-and-forget and its rejection is swallowed:
  `writeQueue = writeQueue.then(async () => { … }).catch(() => undefined)`
  ([`src/phone/PhoneApp.vue:640-657`](../../src/phone/PhoneApp.vue)); the
  delivery effect returns `{ ok: true }` without awaiting it
  ([`src/pi/piTurnRunner.ts:487-494`](../../src/pi/piTurnRunner.ts)).
- `dropTurn()` — the only thing that clears `open` — is called from
  `dropTurnIfSuperseded()` (a `restartPending` command took the terminal over)
  and from dispose paths. **No EOF path reaches it**
  ([`:505-529`](../../src/pi/piTurnRunner.ts)).

**Symptom: REPRODUCED (Stage 0, 2026-11-03), with a correction to the scenario.**
The prediction was that the second message in an on-screen conversation is
dropped, the bubble reports sent, and the reply poll runs to the ten-minute
deadline. It happens exactly like that — on the **third** message.

- Message 2 is safe by accident: a *new* conversation releases its runner
  unconditionally (`() => deps.release('')`,
  [`src/stores/sessions.ts:2236`](../../src/stores/sessions.ts)), so the draft
  is disposed, `open` is nulled, and message 2 genuinely reopens — paying a
  fresh pi boot.
- Message 3 hits the predicted path: an on-screen conversation keeps its runner
  ([`:2204-2208`](../../src/stores/sessions.ts)); the previous turn's
  settlement killed the tmux session but never dropped the handle, so
  `ensureOpen` early-returned (`open=1`), `waitForReady` early-returned on the
  `ready` flag set during the earlier turn (`ready=0`), the write landed in a
  dead channel and still reported success (`deliver=993`, `adopt=0`), and the
  poll spun on a file that never changed.
- The visible outcome is **worse than predicted**: the optimistic bubble does
  not merely go unanswered, it disappears on re-entry, because the transcript is
  rebuilt from a host file that never received the line. The user loses the
  reply and the evidence that they sent anything, and the composer stays in
  queue/steer mode until the deadline clears the claim.
- This is app behaviour, not a `dev:live` artefact: the mechanism is the
  `ensureOpen`/`waitForReady` early-returns plus the swallowed write rejection,
  none of it browser-specific, and the host-side check (the marker never reached
  the session file) is transport-independent.

Raw capture: `build/pi-turn-stage0/devlive-timings.md` §4 (uncommitted scratch).
Stage 1a of this plan closes the hole §3.2 describes — `TurnPtyHandle.onClose`
reports the death, and [`piTurnRunner.ts:522-524`](../../src/pi/piTurnRunner.ts)
turns it into a `dropTurn()`; see §4 Stage 1a for what shipped and what residual
race it accepts.

### 3.3 The existing test asserts the wrong thing

[`tests/unit/piTurnRunner.test.ts:288-298`](../../tests/unit/piTurnRunner.test.ts),
`'reuses the same handle for a later send after the first turn completes'`,
asserts `openPty` called once and writes `['one','\r','two','\r']`. The fake
handle never dies when `closeSession` fires, so the test is green over a
behaviour that cannot happen on a real host. This is the G6 shape exactly — a
green structural proxy standing in for an absent behaviour assertion. The
harness must model session death before any of this can be tested honestly.

*Status after Stage 1a:* that test is deleted, `closeSession` in the harness
kills the session's handles by default (`killOnClose: false` exists as the
opt-out no test needed), and the replacement is
`'reopens the PTY when the first turn killed its session'`, which asserts where
each line's bytes landed rather than how many times something was called.

### 3.4 The sweep will fight a warm session

[`src/pi/pendingTurns.ts:406-428`](../../src/pi/pendingTurns.ts) encodes:

- answered **and** a local record names it (`delivered`) → `kill` + `forget`;
- answered but **not** delivered here → `continue` — never killed, because
  "an at-rest file on such a pane cannot distinguish a finished turn from one
  the agent has not started writing yet";
- a record naming a session the host no longer has → `forget`
  ([`:390-394`](../../src/pi/pendingTurns.ts)).

So if the runner simply stops killing but still calls `forgetTurn`, the warm
session becomes "a pane this phone never delivered" and **nothing will ever
reap it** — precisely the orphan accumulation `buildPiCloseCommand` exists to
prevent. Keeping sessions warm therefore requires a reaper with a *new*
predicate (idle-for-N), not the existing one (answered-now).

The sweep also only re-arms while something is running —
`armPendingTurnWatch(settlement.running.length)`
([`src/stores/sessions.ts:2549`](../../src/stores/sessions.ts)) — so a warm
idle session would never be revisited. The reaper needs its own cadence.

### 3.5 What a send costs today (for the Stage 0 baseline)

| Segment | Where | Cost |
|---|---|---|
| open PTY + tmux new-session + **pi boot** | `ensureOpen`, [`piTurnRunner.ts:455-503`](../../src/pi/piTurnRunner.ts) | seconds, cold only |
| wait for pi's ready handshake | `waitForReady`, deadline 20 s | cold only |
| assistant baseline | one session-file read = one round trip | every send |
| bracketed-paste pacing | `PASTE_GAP_MS` 120 ms × 2 gaps | multi-line only |
| submit pause | `submitDelayMs` 250 ms | **every send** |
| reply follow | `tail -F` push, 120 ms coalesce ([`src/pi/piStream.ts:50`](../../src/pi/piStream.ts), [`:87`](../../src/pi/piStream.ts)) | per reply |

The instrumentation already exists and needs no new code:
`[pi turn] send open=… ready=… baseline=… deliver=… adopt=… total=…`
([`src/pi/piTurnRunner.ts:833-838`](../../src/pi/piTurnRunner.ts)).

## 4. Design

Staged, each stage independently shippable and independently revertible.

### Stage 0 — evidence (no product change)

**Done 2026-11-03.** Raw captures live in `build/pi-turn-stage0/`
(`devlive-timings.md`, `host-boot-timing.md`) — uncommitted scratch, since
`build/` is gitignored. Host: `192.168.1.3` (user `kai`), tmux 3.2a, pi 1.5.0
(`@earendil-works/pi-coding-agent`), a scratch project under `/home/kai/` and the
`ps-probe` tmux socket, so the maintainer's own sessions were never in scope.

The plan wrote step 1 as reading the instrumentation "over logcat". That channel
does not exist, and four findings replace the plan's method:

- **F1 — there is no logcat channel for page logs.** The Capacitor host is
  configured `loggingBehavior: 'none'`, so `Logger.shouldLog()` drops every
  `console.*` before it reaches Android's log; `[pi turn] …` never appears in
  logcat. The channel actually used is the browser console of `pnpm dev:live`
  (#3022: the same app code over a Node `ssh2` WebSocket bridge). Flipping
  `loggingBehavior` is forbidden, not merely undesirable — the same gate that
  would route page logs into logcat is the one that keeps SSH private key
  material out of them.
- **F2 — the Docker fixture cannot answer this question.** It has no `pi` and no
  `tmux`, so Stage 0 needed a real host.
- **F3 — `dev:live` is code-path-equivalent but transport-different.** It runs
  the same `PhoneApp.vue`, including `turnPtyImplementation` and `piTurnRunner`,
  so the ordering of the stages and the §3.2 reproduction are valid evidence;
  its per-call latency is not comparable to a phone's, because a localhost
  WebSocket over `ssh2` is not the phone's SSH connection over Wi-Fi.
- **F4 — the browser's per-stage numbers are not latency evidence at all.** The
  driving tab was `document.visibilityState === 'hidden'`, and Chrome's hidden
  timer throttling was measured in it: `setTimeout(50)` → 867 ms, `500` → 992,
  `1000` → 2010. Anything whose real cost is under ~1 s reads as ≥1 s, so
  `baseline=1007`, `deliver=993` and `adopt=59995` are throttle floors and
  poll-multiples, not host cost. This invalidates the plan's assumption that the
  browser only understates by a transport constant; it adds a *variable* penalty
  to every stage the runner times internally. The authority for the gate is
  therefore host-side measurement plus the host's own wall clock.

1. ~~Capture `[pi turn] send …` over logcat~~ **Measure pi's boot on the host,
   and read the browser log only for stage ordering.** The plan's probe polled
   `capture-pane -p`, which cannot see `PI_INPUT_READY_MARKER`
   (`'\x1b[?2004h'` is a mode-set escape; it never lands in pane text), so its
   number was a lower bound. `tmux pipe-pane -o` tees the pane's **raw byte
   stream**, so the app's actual readiness signal was awaited host-side and the
   two channels measured the same quantity:

   | What | Reps | Result |
   |---|---|---|
   | pi boot → first pane bytes | 2602 / 2648 / 2657 ms (bare `pi`), 2663 / 2655 / 2867 ms (`pi --session <file>`) | median **2.66 s** |
   | first bytes → `\x1b[?2004h` | 3–5 ms on every rep | the handshake is not a second cost; it is the same frame as the paint |
   | `attach-session` to a pi that already exists, and repaint | one window | **18 ms** |

   `--session <file>` is indistinguishable from a bare `pi`, so the session
   file's size is not the cost. **2.66 s → 18 ms is ~145×**, and it is the whole
   quantity Stage 1b exists to remove. The browser's `ready=2938` for the same
   boot agrees with the host's 2.66 s to within ~280 ms — inside the transport
   constant F3 predicts.

2. §3.2's predicted symptom: **reproduced** (§3.2's verdict block, with the
   correction that it is the third message, not the second, and the reason the
   second is safe).

**Gate: PROCEED.** `open + ready` — the pi cold start — dominates every other
segment for a message that pays it, by more than 10× against `deliver`'s fixed
250 ms submit pause, and it holds with the transport removed. `deliver` did not
dominate, so the premise of this spec stands and §5's choice A is not re-opened.
Stage 1a ships regardless (§6.1). Stage 1b gets its own plan; the number it must
beat is 2.66 s per message, the number it must approach is 18 ms.

### Stage 1a — PTY death becomes observable (correctness, ships regardless of the Stage 0 numbers)

1. `TurnPtyHandle` grows a death signal (`onClose`, or an `eof` flag the runner
   can read) — [`src/session/turnPty.ts:14-21`](../../src/session/turnPty.ts).
2. The read pump reports EOF instead of silently returning —
   [`src/phone/PhoneApp.vue:631`](../../src/phone/PhoneApp.vue).
3. `write` stops swallowing rejection: a failed write must reach the delivery
   controller so `deliver` returns `uncertain` rather than `delivered`
   ([`src/phone/PhoneApp.vue:640-657`](../../src/phone/PhoneApp.vue);
   the controller's `uncertain` path already exists,
   [`vendor/pocketshell-core/src/composerSend.ts:437-448`](../../vendor/pocketshell-core/src/composerSend.ts)).
4. The runner drops a dead handle: EOF → `dropTurn()`, so the next
   `ensureOpen` opens a fresh one and the next `waitForReady` genuinely waits.

This is a hard cut per D22 — no flag, no "legacy silent write" path.

**Shipped (this plan, Tasks 3–5).** Items 1–4 landed as written: `onClose` on the
handle ([`src/session/turnPty.ts:14-29`](../../src/session/turnPty.ts)), the read
pump reporting death on `eof`, on a stale sequence or a mismatched response
([`src/phone/PhoneApp.vue:630-652`](../../src/phone/PhoneApp.vue)) and on the
write the queue used to swallow ([`:675-690`](../../src/phone/PhoneApp.vue)), and
the runner turning any of that into a `dropTurn()`
([`src/pi/piTurnRunner.ts:522-524`](../../src/pi/piTurnRunner.ts), with the
death watcher released only where the handle is put down — `dropTurn`, `rebind`,
`dispose` — because a settlement unsubscribes from the *data* stream before it
kills the session).

**Residual race this accepts rather than closes.** A death that is reported only
*after* `deliver()` has already returned `delivered` still leaves the send
believing the line landed, and its reply poll then runs to the turn deadline.
Probed against the shipped harness rather than assumed: a death queued a
microtask after the final `SUBMIT_KEY` write is **caught**
(`{ok: false, error: 'Composer transport generation changed.'}`), because
`composerSend`'s `failIfStale()` runs after every write including the last one
([`vendor/pocketshell-core/src/composerSend.ts:396-404`](../../vendor/pocketshell-core/src/composerSend.ts)).
The window that remains is therefore a whole round trip wide, not one tick: the
channel accepts the bytes and only the next `readPty` reports `eof`. Closing even
that needs a `failIfStale()` before the `return { status: 'delivered' }` in the
frozen core, which §2's non-goals exclude. The accepted exposure is one turn,
reported sent, whose poll then times out — bounded, and strictly narrower than
the every-third-message silent loss §3.2 observed.

### Stage 1b — keep the session warm, and reap it on idle

1. **On answer, kill only when nobody is left to reuse the pane.** The runner
   keeps the session when it still owns a live PTY (the chat is on screen);
   the existing kill stays for the background case and for release/dispose.
   `forgetTurn` must be decoupled from `closeSession` so a warm session does
   not fall into §3.4's "never delivered ⇒ never killed" hole — the reaper
   below is what owns it instead.
2. **Idle reaper, host-side.** One exec over the listing the sweep already
   builds — names from `tmux -L pocketshell-pi list-sessions`, files from
   [`listTurnSessionFilesCommand`](../../src/pi/piCommands.ts)
   ([`src/pi/piCommands.ts:39`](../../src/pi/piCommands.ts)), matched by
   recomputing the name hash in
   [`src/pi/liveTurns.ts`](../../src/pi/liveTurns.ts): kill a turn session
   whose file satisfies the *existing* `isRunAnswered` predicate
   ([`src/pi/pendingTurns.ts:138`](../../src/pi/pendingTurns.ts)) **and** whose
   mtime is older than `IDLE_REAP_MS`. Reusing `isRunAnswered` is deliberate —
   it introduces no second notion of "finished", which is how D44 accumulated
   five corrections. A session with no local record has no owed count, so the
   reaper reduces to the same fallback the sweep already uses — the file's own
   `countAssistantTurns` as the target
   ([`src/pi/pendingTurns.ts:414`](../../src/pi/pendingTurns.ts)).
3. **Reaper cadence is its own**, not `armPendingTurnWatch`, because warm idle
   sessions exist precisely when nothing is running (§3.4).
4. **Safety invariants the reaper must not break**, each needing a test:
   a session that still owes work is never reaped; a session another device
   delivered is never reaped while it is working; a draft (`ps-pi-draft-…`) is
   never matched by name and so is out of scope; a host that cannot be listed
   (`liveTurns === null`) reaps nothing.

**Proposed `IDLE_REAP_MS`: 10 minutes** — long enough that a user reading a
reply and typing the next message never hits it, short enough that a phone
left in a pocket does not park a node process per conversation for a day.
Vetoable in review (§6.3).

### 4.1 What the send path looks like after Stage 1

Warm: baseline read (1 round trip) + 250 ms submit pause + writes. The pi
boot, the tmux `new-session`, and the ready handshake disappear from every
message after the first in a conversation.

Cold (first message, or after a reap, or after a host reboot): unchanged.

## 5. Alternatives considered

- **A (chosen): keep the pi process warm under the existing tmux design.**
  Smallest blast radius; no host install; D44 and D45 untouched; reuses the
  one `isRunAnswered` predicate the codebase already trusts.
- **B: adopt remote_pi's transport (extension + WebSocket relay).**
  **Rejected.** Three reasons, all from their own repo:
  1. The relay reads plaintext. `ct` is base64 of cleartext JSON, not
     ciphertext; their threat model says a public relay operator "reads
     everything that passes, persists it", mitigation self-host
     ([`PROTOCOL.md:397`](file:///D:/projects/remote_pi/PROTOCOL.md),
     [`:409`](file:///D:/projects/remote_pi/PROTOCOL.md),
     [`README.md:76-84`](file:///D:/projects/remote_pi/README.md)). Our model
     is SSH — end-to-end encrypted to the maintainer's own box, no third
     party. This alone is disqualifying.
  2. It would require installing an extension and running a supervisor daemon
     on the host, contradicting D45's "host contract is SSH + `pi`".
  3. pi's extension surface is a moving target with a severe failure mode:
     pi 0.83 removed `ModelRegistry.create` / `AuthStorage.create` from the
     package, and an extension importing them **crashed the whole pi process**
     (their issue #112,
     [`pi-extension/src/actions/registry.ts:8-15`](file:///D:/projects/remote_pi/pi-extension/src/actions/registry.ts)).
     The package was also renamed `@mariozechner/` → `@earendil-works/`. This
     is the same class of trap our own aplexer pinning rules exist for.
- **C: `pi --mode rpc` over the exec channel we already have (follow-on spike,
  NOT this change).** Genuinely promising and cheap to prototype — the stdin
  primitive is already built and already documented as reserved for it:
  > Write to the channel's stdin. Unused by the watch, **used by an RPC**.

  [`src/native/sshCapability.ts:279-280`](../../src/native/sshCapability.ts);
  `openNativeStream` already returns `write`
  ([`:291-317`](../../src/native/sshCapability.ts)), the native side implements
  it ([`SshCapabilityPlugin.java:748-765`](../../android/app/src/main/java/com/pocketshell/app/SshCapabilityPlugin.java)),
  and only `createAndroidStreamSource` currently drops it
  ([`src/platform/android/piStreamSource.ts:55-65`](../../src/platform/android/piStreamSource.ts)).
  So it is a TS-only change, no native work. pi documents the mode as "JSON on
  stdin/stdout, no TTY, explicitly designed for embedding"
  ([`plan/26-daemon-mode.md:16`](file:///D:/projects/remote_pi/plan/26-daemon-mode.md));
  prompt wire is `{ id, type: "prompt", message }`
  ([`rpc_child.ts:320-329`](file:///D:/projects/remote_pi/pi-extension/src/daemon/rpc_child.ts)),
  with `--continue` / `--name` / `--approve`
  ([`:172-190`](file:///D:/projects/remote_pi/pi-extension/src/daemon/rpc_child.ts)).

  **Why it is a spike and not a plan:**
  1. The raw RPC stream has **no turn-level event** — only per-message
     start/end, and `response{command:"prompt"}` fires at preflight (turn
     *start*, not end), so the authoritative busy signal is a `get_state`
     round trip
     ([`rpc_child.ts:138-147`](file:///D:/projects/remote_pi/pi-extension/src/daemon/rpc_child.ts),
     [`:379-394`](file:///D:/projects/remote_pi/pi-extension/src/daemon/rpc_child.ts)).
     D44's "is this round over?" problem survives, in a new shape.
  2. Its wire format is reverse-engineered, not documented — their own
     internal plan doc states a different shape
     (`{type:"command", command:"sendUserMessage"}`) than their shipping code,
     and annotates it "exact format comes from the Pi SDK". Pinning it needs a
     behaviour test, never a version string (our aplexer lesson).
  3. **They retreated from it.** cockpit 2.0 (2026-09-17, roadmap k16) removed
     the native `pi --mode rpc` agent and went terminal-first: "do not
     reintroduce any of it: the agent path is the terminal"
     ([`cockpit/CLAUDE.md:12-17`](file:///D:/projects/remote_pi/cockpit/CLAUDE.md)).
  4. Disconnect survival is unsolved for it: an exec channel dying is stdin
     EOF, which is D44's original SIGHUP bug. tmux preserves the process but
     puts JSONL through a PTY (escape sequences, pane-width wrapping). A
     possible shape — RPC child inside tmux with stdin/stdout redirected to a
     fifo and a jsonl file we read and write out-of-band — is a conjecture,
     not a design.
- **D: narrow the pacing sleeps.** Rejected as a non-goal (§2): the values are
  measured, and re-measuring them is a separate change with its own evidence
  burden.

## 6. Called decisions (maintainer may veto in review)

1. **Stage 1a ships even if Stage 0 refutes the perf premise.** A write into a
   dead channel that reports `delivered` is a silent-loss hazard independent
   of any latency question.
2. **Warm only while the runner owns a live PTY.** No pool of pre-warmed
   sessions, no "keep the last N conversations warm". One live chat, one warm
   pi. Rationale: bounded by construction, and the reaper is a backstop rather
   than the primary mechanism.
3. **`IDLE_REAP_MS` = 10 minutes**, host-side, keyed on the existing
   `isRunAnswered` plus file mtime. No new liveness notion is introduced.
4. **The reaper is a new rule, not a widening of `reconcilePendingTurns`.**
   That function's "answered ⇒ kill now" and "not delivered here ⇒ never kill"
   semantics are D44-load-bearing and stay exactly as they are.
5. **No relay, no extension, no host daemon** — options B and C are out of
   this change; C becomes a separate read-only research issue whose deliverable
   is a verdict, not code.
6. **The test harness must model session death before Stage 1a is reviewed.**
   The §3.3 test is corrected in the same change, not left green.

## 7. Documentation updates (part of this change)

- `docs/decisions.md`: amend **D44** — the clause "The session is killed only
  when its turn was actually answered" becomes "…only when its turn was
  actually answered **and no live runner is left to reuse it**; an idle warm
  session is reaped host-side after `IDLE_REAP_MS`". Record the origin
  (remote_pi comparison, 2026-11-02) and cross-ref D45, D22. If Stage 0
  refutes the premise, D44 is unchanged and this spec is closed with the
  numbers recorded.
- `docs/architecture.md`: the turn-lifecycle paragraph gains the warm/reap
  states.
- `docs/decisions.md` **Open** section: add the `pi --mode rpc` spike as an
  open question with §5C's four blockers summarised, so the retreat is not
  re-litigated from scratch later.
- `docs/lessons-learned.md`: the §3.3 shape — a reuse test whose double cannot
  die, green over a behaviour impossible on the host — as a G6 instance.
- No `AGENTS.md` change: the host contract is unchanged.

## 8. Testing impact

- **Harness first (blocking).** `tests/unit/piTurnRunner.test.ts`'s fake PTY
  gains the ability to die (on `closeSession`, and on demand), and
  `'reuses the same handle for a later send after the first turn completes'`
  is rewritten to assert real behaviour: after the session dies, the next send
  reopens; while it is warm, it does not.
- **Stage 1a class coverage (G2), each a test:** EOF mid-turn; write rejected
  by the channel; host reboot between sends; pi crashing on its own; a
  `restartPending` command superseding the PTY (the existing path must keep
  working).
- **Stage 1b class coverage:** warm session reused across two sends with
  `openPty` called once; released on chat switch; killed on dispose; reaped
  after idle; **not** reaped while owing work; **not** reaped when another
  device delivered it; nothing reaped when `liveTurns === null`; a draft
  session never matched.
- **D44 regression net:** the existing reconnect / grace / adoption /
  `has-session` journeys must stay green unchanged — they are the proof this
  did not disturb the subsystem D28 calls the most critical.
- **Gates:** `scripts/run-js-unit-gate.sh`, `pnpm typecheck`,
  `scripts/assemble-debug.sh`. This is user-facing chat work, so reviewer
  emulator evidence per `docs/review-standards.md` is required, and the
  acceptance is a **before/after timing comparison on the packaged app**, not
  a unit assertion — the maintainer's complaint is a felt latency, and only
  measured latency answers it.

## 9. Risks

- **Orphaned pi processes on the host (highest).** The reaper is the only
  thing bounding them, and it runs from the phone — a phone that never
  reconnects leaves them. Mitigation: the reaper is host-side and idempotent,
  so *any* later connection reaps *all* idle sessions, not just its own;
  and Stage 0's numbers should include a process count before/after a day of
  normal use.
- **Killing a turn that only looks finished.** This is D44's whole history —
  five recorded corrections, each a case where "answered" was wrong. Reusing
  `isRunAnswered` rather than inventing a predicate is the mitigation, and the
  reaper adds an mtime floor on top of it, so it is strictly more conservative
  than the kill it replaces.
- **The perf premise may be wrong.** Stage 0 exists for that; the gate is
  explicit and the spec says stop-and-replan rather than build the reaper.
- **Warm-session memory on the host.** One node process per actively-used
  conversation is a real cost on a small box. Bounded by decision §6.2 (one
  live chat) and the idle reap.
- **Stage 1a may surface a previously-silent failure as a visible one.** A
  send that used to report `delivered` and quietly time out will now report a
  failure. That is the point, but it may look like a regression in the first
  day of use; the maintainer should expect it.

## 10. Process

Per `process.md`: the orchestrator files one GitHub issue from this spec —
**Stage 0 first, as its own issue**, because its output gates everything else
and it produces no product change. Stages 1a and 1b are separate issues with
separate implementer/reviewer loops; 1b is blocked on 1a. An implementer
executes in its own worktree (code + tests, no commits); a reviewer posts
APPROVED/CHANGES REQUESTED with emulator evidence; the orchestrator builds the
debug APK (`scripts/build-android-debug.ps1` on this Windows box), hands the
maintainer the path / version / sha256, and waits for the on-phone verdict
before anything merges.

The `pi --mode rpc` spike (§5C) is a `researcher` issue, read-only, one
structured comment, no code.
