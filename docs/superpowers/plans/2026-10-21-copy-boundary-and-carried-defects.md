# Plan 6 — Copy boundary, the three carried-over defects, and a re-accepted packaged app

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish F4/F5 honestly (the `keyManagement.ts` English family and the
copy guard's blind spot), close the three carried-over defects (4a/4b/4c), and
re-walk the acceptance on a freshly built APK so the record matches reality.

**Architecture:** No new subsystem. F4's remainder is a translation plus a
guard that asserts on the authoring file; 4a–4c are local changes in the
editor and the store; the acceptance task reuses the existing
`build-android-debug.ps1` + `start-emulator.ps1` + `adb` walk.

**Tech Stack:** Vue 3 (`<script setup>`), Pinia, Vitest 2.1.8 + jsdom, Gradle
8.14.3 / AGP 8.13.0, JDK 21, Android SDK 36, AVD `test` (API 35).

**Spec:** `docs/superpowers/specs/2026-10-21-copy-boundary-and-carried-defects.md`
**Predecessor plan:** `docs/superpowers/plans/2026-10-21-key-import-and-connection-copy.md`
(Plan 5b — F3/F4/F5) · **Ledger:** `.superpowers/sdd/2026-10-19-phone-shell-tabs-chat/progress.md`
**Acceptance record:** `docs/acceptance/2026-10-19-wechat-ui.md`

---

## Starting state (read this first)

`HEAD = e3e62f5` ("feat(connections): reach the key vault from the editor (F3)").

**The working tree is dirty and its changes are mid-review.** It already
contains Plan 5b's Task 2/3 work (F4 Chinese copy + F5 validation lifecycle),
uncommitted, and an independent reviewer returned **CHANGES REQUESTED** on it.
The plan's first task is therefore *not* a fresh implementation — it is the
review round. Do not discard the working tree; do not re-implement what is
already there.

Already changed in the working tree (do not redo):

| Path | What is in it |
|---|---|
| `src/platform/android/hostStore.ts` | `savedHostProblem()` (codes) + `validateSavedHost()` (byte-identical English wrapper) |
| `src/components/SshKeysScreen.vue` | Chinese template/script copy; `${algorithm} 密钥` label |
| `src/components/connections/ConnectionEditor.vue` | Chinese validation copy via problem codes; R36 error lifecycle (`shownError`/`clearProblem`) |
| `src/stores/connections.ts` | Chinese `lastError` for dial failure |
| `src/credentials/buildSshCredential.ts` | Chinese `MissingPasswordCredential` |
| `tests/unit/connectionCopy.test.ts` (new) | The copy guard (68 entries, 4 files) |
| `tests/unit/{connectionEditorAuth,hostStoreAuth,sshKeySetup,sshKeyVault,connectionsCredentials,buildSshCredential}.test.ts` | Updated assertions, Chinese, same strength |
| `docs/superpowers/plans/2026-10-21-key-import-and-connection-copy.md` | Residual section (native-plugin English) |

## Rulings

- **R39** `keyManagement.ts`'s nine strings (`:51`, `:63`, `:66`, `:82`, `:88`,
  `:101`, `:107`, `:111`, `:114`) are **translated**. They are JS-owned and on a
  live path (`ConnectionEditor.vue:24` → `androidKeyManager` → `SshKeysScreen`
  → `failureMessage(cause, …)` returns `cause.message` verbatim). The native
  plugin excuse does not apply to them.
- **R40** The copy guard asserts **per authoring file**. Each entry names the
  file that *authors* the string, and the guard fails if that string is
  present in that file. Adding `src/credentials/keyManagement.ts` to the file
  set is part of R39, not an extra.
- **R41** The boundary note may name **only** families that are **not** JS-owned
  user copy (native plugin prose, native-contract validation in
  `src/native/sshKeyVault.ts`, `UnsupportedHostAuth`,
  `hostStore.ts`'s `MissingHostCredential` refusals — that last one is
  JS-owned but lives in a *store* contract with its own consumer; state it
  plainly rather than pretending it is native). The note's closing assertion
  stays as the anti-rot check.
- **R42** `validateSavedHost`'s English sentences stay **byte-identical**. The
  wrapper survives as a public contract with a test pinning its exact
  sentences; the *justification* changes (§2.4 of the spec) and the code
  comment must say so.
- **R43** **4a.** With a remember-toggle off, the editor must not accept a
  secret the user believes will be kept, and a new host saved with the toggle
  off must not become an undialable `passwordCredentialId: ''` by accident.
  Either the save is refused with a Chinese reason, or the record is written
  in a form that still dials (and the user is told which).
- **R44** **4b.** A failed save/clear keeps the **cause** and shows it in
  Chinese; the cause also reaches a diagnostic sink
  (`durableStorage.ts:259`'s `appendDiagnosticEvent` is the precedent).
- **R45** **4c.** 保存 and 清除 are guarded against a second in-flight
  invocation; a double tap performs one action and seals one secret id. The
  guard must not leave an orphan (Plan 5's Global Constraints).
- **R46** The migration question is **presented, not decided**. R37 stands. A
  task may gather evidence and record the maintainer's answer; it may not
  wire the migration in, remove it, or restore the deleted journey test.
- **R47** Out of scope: the native plugin's English sentences (needs error
  codes — a native-contract change; Plan 5b's Residual already records it),
  the dormant packaged-lane cluster (its own plan), the 53 dead screens
  (blocked on a user decision), and a fourth tab.
- **R48** No existing `data-testid` may be renamed. The acceptance walk and
  the existing tests depend on them by name.

## Global constraints

- Never weaken a gate to make it pass; retire with a recorded reason.
- No machine-specific absolute path in the repo.
- Never `git stash`; never touch `vendor/**`; one flat top-level `describe` per
  unit-test file; manifest titles from a **fresh JSON report**.
- Commit only after an independent reviewer replies `APPROVED` **and** the
  controller has re-verified. The controller commits; implementers never do.
- Windows: invoke PowerShell **only** through the PowerShell tool (the bash
  tool rejects `powershell`). Use `bash` for the shell scripts — Git Bash 5.3
  with `/bin/sh` and `base64` resolve now.
- Use `npx vitest run --no-file-parallelism` — this box's sandbox
  intermittently denies the parallel web-transform cache write.

---

### Task 1: Close the review round on F4/F5 (the `keyManagement.ts` family)

**Files:**
- Modify: `src/credentials/keyManagement.ts`
- Modify: `tests/unit/connectionCopy.test.ts`
- Modify: `tests/unit/sshKeySetup.test.ts`, `tests/unit/androidHostKeys.test.ts`
  (the two tests pinning the old English labels — `sshKeySetup.test.ts:167,169`,
  `androidHostKeys.test.ts:184`)
- Modify: `docs/superpowers/plans/2026-10-21-key-import-and-connection-copy.md`
  (the Residual section)
- Modify: `src/platform/android/hostStore.ts` (the comment at `:140-144`, R42)

- [ ] **Step 1: Translate the nine strings (R39).**
  `:51` `'Imported SSH key'` → 导入的密钥; `:66` `'Pasted SSH key'` → 粘贴的密钥;
  `:63` `'Paste a private key first.'` → 请先粘贴私钥。; `:82` → 无法复制公钥。;
  `:88` → 无法分享公钥。; `:101` → 所选密钥已不可用，请刷新列表后重试。;
  `:107` → 主机密钥关联在删除前已变更，请刷新主机后重试。; `:111` →
  Android 密钥库未确认删除。; `:114` → 密钥删除失败且主机关联未能恢复，请在连接前刷新已保存的主机。
  Match the voice already used in `SshKeysScreen.vue`'s Chinese fallbacks, and
  keep each message's *shape* (imperative + what to do next) — the English
  sentences all say what failed and what to do.

- [ ] **Step 2: Re-point the guard at the authoring file (R40).**
  `tests/unit/connectionCopy.test.ts` currently asserts "Chinese present and
  English absent" **within one file**, with the file list at `:13-46` and the
  closed-set assertion at `:227`. Two changes:
  1. Add `src/credentials/keyManagement.ts` to the file set and add
     `CREDENTIALS`-style entries for all nine strings (Chinese present, English
     absent **in that file**).
  2. Make each entry **two-sided per authoring file**: the Chinese must be
     present in the authoring file, and the English must be absent **there**.
     The point of R40 is that moving a string to another file must fail the
     guard, not satisfy it.

- [ ] **Step 3: Prove the guard now fails for the right reason.**
  Mutation: change `keyManagement.ts:82` back to `'The public key could not be
  copied.'` → the guard must go red **naming that file**. Then a second
  mutation: move the Chinese string *out* of `keyManagement.ts` into
  `SshKeysScreen.vue` → the guard must also go red (it is not "translated").
  Paste both outputs.

- [ ] **Step 4: Fix the two label tests.**
  `tests/unit/sshKeySetup.test.ts:167,169` and
  `tests/unit/androidHostKeys.test.ts:184` pin `'Imported SSH key'` /
  `'Pasted SSH key'` / the copied-text sentence. Update them to the Chinese
  at **the same strength** (same specificity, not a looser regex). Say which
  assertion you changed and why it is not weaker.

- [ ] **Step 5: Close the boundary note (R41).**
  Rewrite the note at the top of `tests/unit/connectionCopy.test.ts` so it
  names **only** non-JS-owned families:
  - the native plugin's prose (pasted-public-key etc.), which arrives as
    `cause.message` from Java;
  - native-contract validation in `src/native/sshKeyVault.ts`;
  - `UnsupportedHostAuth`;
  - `hostStore.ts`'s `MissingHostCredential` refusals — **state plainly** that
    these are JS-owned, that `hostStore.save()` is a live caller, and that
    Task 3 (R44) is what makes the cause visible in Chinese rather than
    leaving the raw sentence in the user's face. Until Task 3 lands, this
    family is listed as *known English, with the reason*.
  Keep the closing assertion that pins the boundary, and extend it to assert
  that `keyManagement.ts` is **not** in the note's family list (so the note
  cannot silently re-absorb a translatable family).

- [ ] **Step 6: Update the Residual section of the 2026-10-21 plan.**
  It currently says the native plugin is the only source of English on this
  path. Amend it: the `keyManagement.ts` family is **closed** (R39); what
  remains is native plugin prose and the `hostStore` refusals, and the latter
  is Task 3's business. Keep the native-error-codes argument intact.

- [ ] **Step 7: Update the `hostStore.ts` comment (R42).**
  `:140-144` says the sentences are English "because `src/sharedApp/hostForm.ts`
  … depend on these exact sentences". That reason is now wrong (§2.4 of the
  spec: `sharedApp` has no HTML entry and is unreachable in the packaged app).
  Rewrite it: the wrapper is a public contract whose exact sentences are
  pinned by `tests/unit/hostStoreAuth.test.ts`; the phone shell maps
  `savedHostProblem` codes to Chinese. Do **not** change the sentences
  themselves.

- [ ] **Step 8: Verify.**
  ```
  npx vue-tsc --noEmit
  npx vitest run --no-file-parallelism tests/unit/connectionCopy.test.ts tests/unit/sshKeySetup.test.ts tests/unit/androidHostKeys.test.ts tests/unit/hostStoreAuth.test.ts tests/unit/sshKeyVault.test.ts tests/unit/connectionEditorAuth.test.ts tests/unit/connectionEditorKeySheet.test.ts
  ```
  Refresh `scripts/js-unit-test-manifest.json` from a **fresh JSON report** if
  any title changed.

**Review Focus 1** — the guard must fail on "moved instead of translated"
(R40). A reviewer must be able to perform that mutation and see a red test,
not just read the assertion.

**Review Focus 2** — no assertion may get weaker. Quote before/after for
every changed test line, and confirm the manifest matches a real report.

**Review Focus 3** — the boundary note must name only non-JS-owned families
(R41), and `keyManagement.ts` must not be among them.

---

### Task 2: 4a — the remember-toggle must not silently discard

**Files:**
- Modify: `src/components/connections/ConnectionEditor.vue`
- Modify: `src/platform/android/hostStore.ts` (only if the record shape must
  change — say why)
- Modify: `tests/unit/connectionEditorAuth.test.ts` (or a sibling test file
  with ONE flat top-level `describe`, R14.5)

**The defect (measured, do not re-diagnose):**
- `ConnectionEditor.vue:148` — with `rememberPassword` off, a new password
  host is written with `passwordCredentialId: ''`. It cannot be dialled; the
  only clue is the dial-time `/password/i` error.
- The field keeps accepting keystrokes that are then dropped, with no
  indication to the user.

- [ ] **Step 1: Decide and write down the contract.**
  Two acceptable shapes; pick one and record it in the task report:
  - **(a) Refuse the save.** With the toggle off and a password typed, the
    save is refused with a Chinese reason: e.g. 未开启"记住密码"时，保存的密码无法用于连接，请开启后重试。
  - **(b) Save honestly.** The record is written in a form that still dials
    (the password is sealed and the toggle's meaning is "do not keep it in
    this app's vault" is **not** what the code can honour) — if you pick this,
    say exactly what the record looks like and why it dials.
  **Do not** pick a shape that leaves the host undialable without saying so.

- [ ] **Step 2: Implement it (R43).**
  Also make the *typing* honest: when the toggle is off, the field must
  either be disabled or carry a visible Chinese note that what is typed will
  not be kept. The note must not be the only signal — the save behaviour must
  match it.

- [ ] **Step 3: Test both halves.**
  - A new password host with the toggle off: the outcome is the contracted
    one — refused with the Chinese reason, **or** saved in a dialling form.
    The test must assert the concrete outcome, not "an error happened".
  - With the toggle **on**, the same flow must still seal and dial
    (regression guard — Plan 4b's `RememberedSecretStoreTest` covers the
    store half; add the editor half).
  - The existing R30 contract must still hold: a secret is emitted only while
    its toggle is on. Re-read R30 in
    `docs/superpowers/plans/2026-10-19-native-credentials.md:420` before
    touching this.

- [ ] **Step 4: Verify.** `npx vue-tsc --noEmit` + the touched test files +
  `tests/unit/rememberedSecretStore.test.ts` (or its current name — find it).

**Review Focus 1** — the test must fail if the fix is reverted. Show the
mutation. A test that asserts "an error is shown" instead of "this specific
error is shown for this specific reason" is not evidence.

**Review Focus 2** — R30 must not be weakened. If your change lets a secret
reach the store while its toggle is off, that is CHANGES REQUESTED.

---

### Task 3: 4b — the failed-save copy must carry the cause

**Files:**
- Modify: `src/components/connections/ConnectionsList.vue`
- Modify: `tests/unit/connectionEditorAuth.test.ts` (or a sibling, R14.5)

**The defect (measured):** `ConnectionsList.vue:81` —
`editorError.value = '保存失败，请重试。';` (the `catch` opens at `:80`) — the
`Error` thrown by `hostStore.save()` (which names the specific problem) is
dropped. Same shape at `:95` for the clear path (`catch` at `:94`).

- [ ] **Step 1: Map the causes.**
  Grep every `throw` reachable from `store.save()` and `store.forgetSecrets()`
  and list the messages a user could see. The list is the contract for step 2.
  Include `hostStore.ts`'s `validateSavedHost` sentence (the live path from
  §2.4) and `buildSshCredential.ts`'s already-Chinese message.

- [ ] **Step 2: Show the cause in Chinese (R44).**
  The editor's error line must carry the specific reason, in Chinese, next to
  the generic "保存失败" line — not instead of it. If a cause is not
  translatable, map it through a table like `SAVED_HOST_SENTENCE`; if a cause
  is an unexpected exception, keep the generic line and put the raw text in
  the diagnostic sink.

- [ ] **Step 3: Reach a diagnostic sink.**
  Follow `durableStorage.ts:259`'s `appendDiagnosticEvent` precedent: write
  the raw cause there so support can diagnose it. Do **not** write the
  user's secret or passphrase into a diagnostic record.

- [ ] **Step 4: Test both halves.**
  - A save that fails with a *known* cause shows that cause in Chinese.
  - A save that fails with an *unknown* cause shows the generic line, and the
    cause is in the diagnostic sink (assert the sink was called with it).
  - Nothing regressed: a successful save still closes the editor and clears
    the error.

- [ ] **Step 5: Verify.** `npx vue-tsc --noEmit` + the touched test files.

**Review Focus 1** — no secret material may reach the diagnostic sink. A
reviewer must be able to point at the line that guarantees it.

**Review Focus 2** — the R36 precedence from Plan 5b must still hold: a
`props.error` from the list keeps precedence over a local edit until the save
is retried.

---

### Task 4: 4c — an in-flight guard on 保存 / 清除

**Files:**
- Modify: `src/components/connections/ConnectionsList.vue`
- Modify: `src/stores/connections.ts` (if the guard belongs in the store)
- Modify: `tests/unit/connectionEditorAuth.test.ts` (or a sibling, R14.5)

**The defect (measured):** `ConnectionsList.vue:74-100` — both actions are
unguarded. A double tap on 保存 calls `store.save()` twice; because `save`
reads `previousRecords` *before* sealing (`src/stores/connections.ts:187`),
the first seal's id becomes an **orphan**. Plan 5's Global Constraints say
"never leave an orphan".

- [ ] **Step 1: Choose where the guard lives and write down why.**
  Either the component disables the buttons while an action is in flight, or
  the store serialises the operation. **The store is the stronger place** —
  the component alone leaves the store callable twice from anywhere. If you
  guard only the component, say why the store-level path is unreachable.

- [ ] **Step 2: Implement it (R45).**
  A second invocation while one is in flight must be a **no-op**, not a
  second seal. The button must visibly reflect the in-flight state
  (disabled + a Chinese hint) so the user is not left tapping a dead button.

- [ ] **Step 3: Test it.**
  - Double tap on 保存 → `store.save` is called **once**, and exactly one
    secret is sealed (assert the seal count, not just the call count).
  - Double tap on 清除 → `forgetSecrets` runs once.
  - The guard **releases**: a failed save can be retried (this is the half
    that is easy to get wrong — a guard that latches on failure strands the
    user).

- [ ] **Step 4: Verify.** `npx vue-tsc --noEmit` + the touched test files.

**Review Focus 1** — the release-after-failure half must be tested. A guard
that never releases is a new defect.

**Review Focus 2** — no orphan may be created. If the implementation seals
before it knows the previous record, that is the same bug with a new shape.

---

### Task 5: The migration question — present it, do not decide it

**Files:**
- Create: `.superpowers/sdd/2026-10-19-phone-shell-tabs-chat/migration-question.md`
- Modify: `docs/acceptance/2026-10-19-wechat-ui.md` (a "not proven" line)

- [ ] **Step 1: Assemble the evidence (R46).**
  State, with `path:line`:
  - `runInstalledDataMigration` is defined at
    `src/migration/installedDataMigration.ts:857`;
  - its only callers are `src/App.vue:1441` (the **unmounted** legacy shell)
    and `src/sharedApp/main.ts:33` (`sharedApp` has **no HTML entry** —
    `index.html:17` loads only `/src/main.ts`, and the built `dist/` has no
    `sharedApp` chunk);
  - therefore **no reachable entry point runs the migration**;
  - what the migration actually moves (legacy preferences, legacy hosts, the
    legacy SSH-key database → vault ids — cite the code, do not paraphrase);
  - who would be affected: a user upgrading from the 0.5.x app into this
    0.6.0 phone shell, and what they would lose.

- [ ] **Step 2: Write the two options with their consequences.**
  **A** — the phone shell must migrate: wire it into `src/main.ts` boot, and
  `InstalledDataMigrationJourneyTest` comes back (it was deleted in `3f5d271`
  as bound to the old shell — a replacement would be a new journey against
  the phone shell, not a resurrection).
  **B** — migration is a 0.5.x-era concern and 0.6.0 starts clean: the
  unreachable call sites are correct, the deleted test stays deleted, and the
  upgrade path is documented as "start over".
  For each: what it costs, what it risks, and what it means for the
  acceptance record.

- [ ] **Step 3: Record the maintainer's answer.**
  If no answer is available, record **the question and the evidence**, with
  the acceptance record saying that the upgrade path is *unresolved*. Do not
  pick an option. Do not wire or unwire anything.

- [ ] **Step 4: Update the acceptance record.**
  Add a line stating the migration/upgrade path is not proven, and why.

**Review Focus 1** — the document must not read as if a decision was made.
If it does, that is CHANGES REQUESTED even if the decision happens to be the
right one.

---

### Task 6: Re-accept the packaged app

**Files:**
- Modify: `docs/acceptance/2026-10-19-wechat-ui.md`
- Create: `docs/acceptance/2026-10-21-wechat-ui-rerun.md` (the new walk)
- Create: screenshots under `docs/acceptance/`

**This task closes the loop Plan 5b left open: F3 was fixed in code and never
walked on a device.**

- [ ] **Step 1: Build.**
  ```
  npm run build:android:debug:win
  ```
  Record the APK path, SHA-256, `versionCode`/`versionName`, and the
  emulator's API level — as `docs/acceptance/2026-10-19-wechat-ui.md` did.

- [ ] **Step 2: Boot.**
  ```
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-emulator.ps1
  ```
  It reuses a running emulator and never kills one it did not start. If the
  emulator hangs, **stop and report** — do not force-kill a pre-existing one.

- [ ] **Step 3: Walk the key path (this is F3's proof).**
  新增连接 → 密钥 → the empty-vault control → import/generate a key → the key
  appears in the `<select>` → save the host. Screenshot each step. Then walk
  the **second**-key path (the `manage-keys` control) — Plan 5b's own fix
  round added it, and it has never been seen on a device.

- [ ] **Step 4: Walk the copy.**
  Every Chinese string the user can now see: the validation problems, the
  vault-read failure, the dial failure, and the key-sheet copy. Record any
  English that still appears — with the file that authored it. **This is the
  empirical check on R39**: the unit tests can only prove the source says
  Chinese.

- [ ] **Step 5: Walk 4a/4b/4c.**
  - Toggle the remember switch off, type a password, try to save → record
    exactly what the user sees.
  - Force a save failure (e.g. revoke/lock the credential store) → record
    what the error line says.
  - Double-tap 保存 → record how many rows appear.

- [ ] **Step 6: Update the acceptance record, item by item.**
  For each of the eight items, one of: **PASS** (with the screenshot that
  proves it), **FAIL** (with what was seen), **NOT ACCEPTED** (with the
  blocker). Item 1 must still pass — if it does not, stop and report that
  first; it is the shell's foundation.

- [ ] **Step 7: State what the walk does not prove.**
  This box has **no SSH server** — only the client (`ssh.exe`; no `sshd`).
  So the *connect* half of item 2, and items 3–8, stay **NOT ACCEPTED** with
  the reason "no reachable SSH host on this box", unless a server is
  actually stood up (WSL is present; `wsl --list` decides whether a distro
  exists). **Never** mark them PASS. If a server *is* stood up, record how,
  and keep the screenshots.

**Review Focus 1** — every item's verdict must be backed by a screenshot or
an explicit "no host, therefore not accepted". A verdict with no evidence is
CHANGES REQUESTED.

**Review Focus 2** — item 1 must still pass. A regression in the tab bar
invalidates the whole walk.

---

### Task 7: Close the plan out

- [ ] **Step 1: Full gate.**
  ```
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-js-unit-gate.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\android-doctor.ps1
  android\gradlew.bat -p android :app:assembleDebugAndroidTest --no-daemon
  npm run build:android:debug:win
  ```
  Paste the **real** numbers. The expected JS-gate state is the current
  baseline (109 files / 835 tests) **plus** this plan's new tests, with the
  **single known Windows-only red** (`sshKeySetup.test.ts:392` — a POSIX
  `0o600` assertion against a Windows `0o666`; it predates this plan and
  must not be "fixed" by loosening it) and nothing else.

- [ ] **Step 2: Update the ledger.**
  Append this plan's section to
  `.superpowers/sdd/2026-10-19-phone-shell-tabs-chat/progress.md`: the
  rulings R39–R48, every commit, the gate numbers, the acceptance outcome
  item by item, and the migration decision (or its absence).

- [ ] **Step 3: Update the handoff.**
  `.../HANDOFF.md` must end up with the new HEAD, the new gate numbers, the
  acceptance outcome, and whatever is still open (the native-plugin error
  codes; the dormant lane cluster; the 53 dead screens; any 4b minor that
  was deferred rather than fixed).

- [ ] **Step 4: Commit.**
  One commit per task, each with a message that states what changed and
  why. The controller commits; implementers do not.

---

## Residual (recorded, not done)

**The native plugin still answers in sentences.** A pasted public key comes
back as *"This is a public key. Paste the private key instead; it starts with
a BEGIN line."* from Java, and reaches the UI as `cause.message` through
`failureMessage(cause, …)` (`src/components/SshKeysScreen.vue`). A Chinese UI
can therefore still show one English clause inside a Chinese sentence. The fix
is for the plugin to return **error codes** the WebView maps to Chinese — a
native-contract change with its own compatibility question (old APK against
new JS, new APK against a cached bundle). **Out of this plan's scope**, and
recorded here rather than attempted inside it.

**The dormant packaged-lane cluster stays.** Plan 5's Task 6 deliberately left
`scripts/connected-js-*.sh` and their companions in place, and recorded them
in `docs/fork-gate-posture.md` §4. They are one large self-contained deletion
with no live consumer; half of it would leave exactly the dangling references
the plan forbids. It deserves its own plan.

**The 53 dead screens stay.** Plan 2 Task 10b is still blocked on the user's
decision about the packaged CI lanes.
