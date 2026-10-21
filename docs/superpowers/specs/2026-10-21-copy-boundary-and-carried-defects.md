# PocketShell — Plan 6 design: finish the copy boundary, close the three carried-over defects, and re-accept the packaged app

Date: 2026-10-21
Status: **draft for approval** (brainstorming output; not yet planned or built)

Predecessor specs: `docs/superpowers/specs/2026-10-19-wechat-ui-pi-design.md`
Predecessor plans: `docs/superpowers/plans/2026-10-21-key-import-and-connection-copy.md`
(Plan 5b — F3/F4/F5), `docs/superpowers/plans/2026-10-19-cleanup-android-acceptance.md`
(Plan 5), `docs/superpowers/plans/2026-10-19-native-credentials.md` (Plan 4).

---

## 1. Where the fork stands

Plan 5 built a working Android toolchain on this Windows box and produced a
**real packaged-APK acceptance walk** (`docs/acceptance/2026-10-19-wechat-ui.md`,
14 screenshots). That walk did not pass: it recorded three product defects and
one unresolved question.

Plan 5b (F3/F4/F5) is **half-done at the moment of writing**:

- **F3 — closed in code, not yet accepted.** `e3e62f5` put the key vault behind
  a sheet inside the connection editor, so a key-auth host can now be created.
  Verified by unit test only; **never walked on a packaged APK**.
- **F4/F5 — in the working tree, uncommitted and unreviewed-then-changes-
  requested.** The Chinese-copy and validation-lifecycle work sits uncommitted
  at `HEAD = caf8b64` (the commit that added this spec and its plan; the F3
  commit is `e3e62f5`). An independent reviewer returned **CHANGES REQUESTED**
  with three findings, one of them a real product defect (§2.1 below).
- **Acceptance items 2–8 remain open.** Item 1 (three tabs) still passes.

So this design covers three things: **finish F4/F5 honestly**, **close the
three carried-over defects** (§3.1–§3.3; §3.4 is a question, not a defect),
and **re-run the acceptance walk** so the record reflects reality instead of
the last walk's snapshot.

## 2. What the review actually found (F4, F5)

The reviewer confirmed five of seven checks clean — the shared contract did not
move, no assertion was weakened, R36's two halves hold, nothing but copy
changed, the manifest matches. It returned CHANGES REQUESTED on:

### 2.1 The English boundary is not where it was drawn — a real defect

`src/credentials/keyManagement.ts` authors **nine error sentences and two
default labels in English**, and eight of the nine sentences are reachable from
the phone shell:

| Line | String the user sees | Reachable from the phone shell? |
|---|---|---|
| `:48` | `'Android did not return a document reference for the SSH key.'` | **yes** — `pickAndImport`, called by `SshKeysScreen.vue:111` |
| `:63` | `'Paste a private key first.'` | yes — `importText` |
| `:82` | `'The public key could not be copied.'` | yes — `copyPublicKey` |
| `:88` | `'The public key could not be shared.'` | yes — `sharePublicKey` |
| `:101` | `'The selected SSH key is no longer available. Refresh the list and try again.'` | yes — `delete` |
| `:107` | `'Host key associations changed before deletion. Refresh the hosts and try again.'` | yes — `delete` |
| `:111` | `'The Android key vault did not confirm key removal.'` | yes — `delete` |
| `:114` | `'Key removal failed and host associations could not be restored. Refresh saved hosts before connecting.'` | yes — `delete` |
| `:123` | `'Select an SSH key before connecting.'` | no — only the unmounted legacy `App.vue:805` and one test |
| `:51` | `'Imported SSH key'` (default label) | yes — renders in the editor's `<select>` |
| `:66` | `'Pasted SSH key'` (default label) | yes — renders in the editor's `<select>` |

The manager is **live**: `src/components/connections/ConnectionEditor.vue:24`
imports `androidKeyManager` from `src/platform/android/hosts.ts`, which builds a
`CredentialKeyManager` from `keyManagement.ts`. `SshKeysScreen.vue` calls
`manager.copyPublicKey` / `sharePublicKey` / `delete` / `pickAndImport` and
renders `failureMessage(cause, …)` — which returns `cause.message` verbatim
(`SshKeysScreen.vue:82-84`). The Chinese fallbacks added in Plan 5b are **dead
code on those paths**: they fire only when `cause` is not an `Error`.

**This is not the native plugin speaking.** `keyManagement.ts` is JS-owned
validation and policy; its own file header says so. The excuse used for the
native plugin ("the plugin answers in sentences, JS cannot translate prose it
did not author") **does not apply here**. It is translatable today, exactly
like `MissingPasswordCredential` was.

### 2.2 The copy guard asserts on the wrong file

`tests/unit/connectionCopy.test.ts` pins "Chinese present in file X, English
absent from file X". For copy/share the English was never in `SshKeysScreen.vue`
— at `HEAD` that file held only an unreachable *fallback* literal, while the
sentence the user actually saw came from `keyManagement.ts`. Deleting the
fallback satisfies the assertion while the screen keeps showing English. The
guard **passes for a wrong reason** on exactly the two entries that matter
least, and cannot distinguish "translated" from "moved out of the file it
greps".

### 2.3 One label translated, its two siblings left English

`SshKeysScreen.vue:40` changed `` `${algorithm.value} key` `` →
`` `${algorithm.value} 密钥` `` — establishing that a default key label **is**
copy in scope. `keyManagement.ts:51` and `:66` are the same kind of string and
stayed English. A user who imports a key with a blank label gets
**"Pasted SSH key"** inside a Chinese sheet and a Chinese `<select>`.

### 2.4 The `sharedApp` premise, re-checked

R35 kept `validateSavedHost`'s English sentences because "the shared app calls
it". Re-verified: `src/sharedApp/` has **no HTML entry** (`index.html:17` loads
only `/src/main.ts`; the built `dist/` has no `sharedApp` chunk) and nothing
outside `src/sharedApp/` imports it — so the shared app is **not reachable in
the packaged app**. But `src/platform/android/hostStore.ts:170` (`save()`) is a
**live** caller of `validateSavedHost`, and its thrown English sentence
reaches the user through `ConnectionsList.vue:81` → `保存失败，请重试。` (the
cause is discarded — see §3.2).

**Consequence: the English wrapper is no longer justified by a live shared-app
caller.** The wrapper may still be kept (it is a public contract with a test
that pins its exact sentences), but the *reason* changes, and — more
importantly — the live path that actually shows a problem to the user is
`hostStore.save()`, which currently discards the cause (§3.2).
## 3. The carried-over defects and the open question

The three defects below (3.1–3.3) were all measured again while writing this
design; all still reproduce. §3.4 is not a defect but an unresolved question
— it is listed here so the reader sees it in the same place, and the plan
presents it rather than deciding it (R46).

### 3.1 (4a) A remember-toggle that is off silently discards what you typed

`ConnectionEditor.vue:148` — with `rememberPassword` off, a **new** password
host is written with `passwordCredentialId: ''`. The host then cannot be
dialled, and the only clue is the dial-time error from
`buildSshCredential.ts:44-46` → `MissingPasswordCredential` (whose message is
**already Chinese** in the current working tree:
`这台主机保存的密码已丢失，请在连接编辑页重新输入。`) — the user is told the
password is missing, but never that *the app chose not to keep it*, which is
what actually happened. The field also keeps accepting keystrokes that are
then dropped, with no indication. Two distinct harms: a host that is
undialable, and typing that appears to do something and does not.

Note the constraint this runs into: R30 clause 1 (predecessor plan
`docs/superpowers/plans/2026-10-19-native-credentials.md:425-431`) says the
editor emits a non-empty `secret` **only** while its remember toggle is on —
"Toggle off ⇒ emit `null`". So the fix cannot be "seal it anyway"; it has to
be either refusing the save or telling the user plainly.

### 3.2 (4b) The failed-save copy discards the cause

`ConnectionsList.vue:81` — `editorError.value = '保存失败，请重试。';` (the
`catch` opens at `:80`). The `Error` thrown by `hostStore.save()` (which
carries the specific problem) is dropped on the floor.

Note that the in-repo precedent usually cited here —
`src/native/durableStorage.ts:259`'s
`appendDiagnosticEvent` — records a **code**, never a message, and the
diagnostic sink cannot hold free text at all (§7.1). "Keep the cause" is
therefore primarily a **UI** obligation; logging it is a second, separate
decision.

A second, distinct path exists and is **not** fixed by this item:
`hostStore.resolve()` throws `MissingHostCredential` (the class is declared at
`src/platform/android/hostStore.ts:63`, its message is the `super(...)` at
`:68`, and it is thrown at `:246`), which reaches the user through
`connections.ts:399`/`:417`/`:426` (`state.lastError = errorMessage(error)`)
→ `ConnectionsList.vue:206`. Two more English throws live in that same file —
`:244` (a password credential that is not available yet) and `:264` (no saved
host for the request). These are a different action (dialing, not saving) and
a different contract family; they stay English by decision (R41), and the plan
must say so rather than let the boundary note imply otherwise.

### 3.3 (4c) No in-flight guard on 保存 / 清除

`ConnectionsList.vue:74-100` — both actions are unguarded. A double tap on
保存 calls `store.save()` twice; because `save` reads `previousRecords` *before*
sealing, the first seal's id becomes an **orphan** — and Plan 5's own Global
Constraints say "never leave an orphan".

### 3.4 The migration question — a product decision, not a task

`runInstalledDataMigration` (`src/migration/installedDataMigration.ts:857`) is
reached from **three** call sites, all of them outside the phone shell:
`src/App.vue:1441` (the unmounted legacy shell), `src/sharedApp/main.ts:33`
(`sharedApp` is unreachable — see §2.4), and `retryInstalledDataMigration`
(`installedDataMigration.ts:963`, itself called from `App.vue:1321`). The
function's own comment says the reload opt-in belongs to "the legacy App.vue".

**No reachable entry point runs the migration.**

This is the maintainer's call, and this design states the options without
picking one:

- **A** — the phone shell **must** migrate installed data, and the missing call
  is a product bug in this fork. (Then: wire it into `src/main.ts` boot, and
  `InstalledDataMigrationJourneyTest` comes back.)
- **B** — migration is a **0.5.x-era** concern, the 0.6.0 phone shell starts
  clean, and the unreachable call sites are correct as they are. (Then: record
  the decision, and the deleted journey test stays deleted.)

**This plan does not decide it.** A task may only *present* the evidence and
record the maintainer's answer. R37 already forbids guessing.

## 4. Goals

- **G1** Every user-facing string reachable on the packaged connection path is
  Chinese, including the `keyManagement.ts` family — or is named in the
  boundary note as a family that is English **on purpose**, with the file and
  the reason.
- **G2** The copy guard fails for the right reason: it asserts on the file
  that **authors** each string, and it fails if a string is merely *moved*
  rather than translated.
- **G3** The three carried-over defects (4a/4b/4c) are closed, each with a
  test that goes red if the fix is reverted.
- **G4** The acceptance record is re-walked on a freshly built APK and states
  exactly what was proven, item by item.
- **G5** The migration question is presented to the maintainer with evidence
  and recorded as a decision, whichever way it goes.

## 5. Non-goals

- **Not** the native plugin's English sentences (the pasted-public-key case
  and friends). Those need **error codes** from the plugin — a native-contract
  change with its own compatibility question (old APK vs new JS, new APK vs a
  cached bundle). Recorded in Plan 5b's Residual; still out of scope here.
- **Not** the dormant packaged-lane cluster and the other deliberate T6
  retirements. That is one large self-contained deletion with no live
  consumer; it deserves its own plan, not a task inside this one.
- **Not** the 53 dead screens (Plan 2 Task 10b) — still blocked on the same
  user decision.
- **Not** the 4b minors that are *not* the three named in §3.
- **Not** a fourth tab, a settings page, a re-mount of the legacy shell, or any
  other way of "adding a key page" that the spec forbids (§8.1 of the WeChat
  design spec: three tabs, and the key surface lives in the add/edit flow).

## 6. Constraints

- **Never weaken a gate to make it pass.** Retire with a recorded reason.
- **No machine-specific absolute path in the repo.** The toolchain stays in
  the git-ignored `.local/toolchain.json`.
- **Never `git stash`**; never touch `vendor/**`; never `rm` a path containing
  `$`.
- **R14.5** — exactly one flat top-level `describe` per unit-test file; the
  manifest's titles come from a **fresh JSON report**, never hand-typed.
- **The packaged APK is the acceptance.** A dev-server render is a pre-check.
- Chinese user-facing copy; no PTY/SSH jargon in user copy; design tokens
  only; ≥48px tap targets; `data-testid` on everything a test or a walk
  touches — and **no existing `data-testid` may be renamed** (the acceptance
  walk depends on them).
- The `validateSavedHost` **English sentences stay byte-identical**. The
  wrapper is a public contract with a test that pins its exact strings; the
  reason it stays English is now "public contract + pinned test", not "the
  shared app calls it" (§2.4).

## 7. The one decision this design does make

**The `keyManagement.ts` family is translated, not excused.**

It is JS-owned, it is on a live path, and every string in it is translatable
without a native change. The boundary note exists for families that **cannot**
be translated in JS (native plugin prose, native-contract validation). Adding a
JS-owned family to that list would make the note a list of excuses, and the
next reviewer would have to re-derive this same finding.

The boundary note is therefore **closed by construction**: it may name only
families that are *not* JS-owned user copy, **with one named class of
exception** — JS-owned **contract** families, whose consumers include the
unreachable shared app, where changing them is a contract change rather than a
translation. That exception covers `hostStore.ts`'s `MissingHostCredential`
refusals and `UnsupportedHostAuth`. The exception must be stated as an
exception, with the file named, not smuggled in as if it were native. The
note's final assertion stays as the anti-rot check: it must assert that
`keyManagement.ts` is **not** in the note's family list, so the note cannot
silently re-absorb a translatable family.

### 7.1 The diagnostic sink cannot carry free text (a correction)

The obvious way to satisfy "keep the cause" — write the raw cause into the
diagnostic sink — **does not work in this repo**, and a plan that asks for it
is asking for the impossible. `src/diagnostics.ts:21-27` defines
`DiagnosticEvent` as `{ id, at, kind, operation, code }`: there is **no
free-text field**, and `appendDiagnosticEvent` passes `kind` / `operation` /
`code` through `safeKind` / `safeOperation` / `safeCode`, which map anything
unknown onto `ssh-operation-failed` / `lifecycle` / `UNAVAILABLE` against
closed whitelists. A cause string is destroyed before it is stored. The
`src/native/durableStorage.ts:259` precedent that was cited for this records a **code**,
never a message.

So "keep the cause" has to mean one of two things, and the plan must say which:

- **(a) Keep the cause in the UI.** The specific reason is shown to the user,
  in Chinese, in the editor's error line. This is the part that is always
  possible: the cause is a short, known sentence at every reachable `throw`.
- **(b) Keep the cause out of the UI but in a log.** The raw text goes to
  `console.error` (the in-repo ad-hoc precedent:
  `src/native/durableStorage.ts:242`, `src/phone/PhoneApp.vue:110`) or to a
  new field on the diagnostic event — which is a **schema change**
  (`DiagnosticEvent` is persisted under `pocketshell.js.diagnostics.v1`) and
  therefore its own decision.

**(a) is the UI half and (b) is the logging half — they are not alternatives
to each other, and the plan must not present them as if they were.** The
editor's error line carries the Chinese reason (a); *in addition*, the raw
cause is logged (b). The only real choice inside (b) is *where* the log goes:
`console.error`, or a diagnostic event whose schema was extended on purpose.
A task that says "write the raw cause there" and then asserts "the sink was
called with it" is unsatisfiable, and an
implementer would either drop the cause silently or invent a schema change
nobody sanctioned.

## 8. What "done" looks like

- `keyManagement.ts` shows Chinese to the user on every path, or an explicitly
  recorded exception naming the file and the reason.
- The copy guard **fails** when an English string is moved instead of
  translated — provable by mutation, not by inspection.
- 4a: a password host saved with the toggle off is either not saveable or
  says so; typing with the toggle off tells the user it will not be kept.
- 4b: the failed-save message carries the cause in Chinese, and the raw cause
  is **logged** (a console log, or a diagnostic event whose schema was
  extended on purpose — see §7.1; the sink as it stands cannot hold text).
- 4c: a double tap on 保存/清除 does exactly one thing and seals one id.
- A **fresh** APK is walked; `docs/acceptance/2026-10-19-wechat-ui.md` is
  updated item by item, and item 1 still passes.
- The migration question is answered by the maintainer and recorded.
- The JS gate, the typecheck, `:app:assembleDebugAndroidTest` and the APK build
  are all run, and their real numbers are pasted — including the known
  Windows-only red.
