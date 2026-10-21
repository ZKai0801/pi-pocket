# Plan — F3: a reachable key-import path, plus the two copy defects beside it

Status: **in progress** (2026-10-21). Owner: controller. Source of the defects:
`docs/acceptance/2026-10-19-wechat-ui.md` findings F3/F4/F5.

## Why this plan exists

The packaged-APK acceptance walk could not create a key-auth host at all, so
**item 2 is FAIL** and **item 8 is NOT ACCEPTED**, and items 3–6 are blocked
behind "no host". The editor's key branch renders

> 密钥库为空 — 先在密钥页导入一把密钥。

but the phone shell mounts no key page: `src/main.ts` mounts `PhoneApp.vue`,
which renders three tab views and the terminal, and `SshKeysScreen.vue` is
referenced only by the unmounted legacy `src/App.vue:45,2044`. The hint tells the
user to go somewhere that does not exist in this app.

## What the spec already decided (do not re-litigate)

- **§8.1** — `AppTabBar.vue` fixed at the bottom, **three** items
  (连接 / 项目 / 会话), tabs are peer roots. No fourth tab.
- **§8.3** — "Key: pick from the vault (import/generate lives **here** or reuses
  the existing `SshKeysScreen` reduced to an import sheet)".

So the key surface belongs to the add/edit flow. Adding a 设置/密钥 tab would
contradict §8.1 and acceptance item 1.

## Rulings

- **R31** The tab bar stays three items. The key surface is reached *from the
  editor*, not from a peer root: `AppTabBar.vue`, `PhoneTab`, and
  `PhoneApp.vue`'s `TAB_HOME_SURFACE` are untouched. Acceptance item 1 must
  still hold exactly as recorded.
- **R32** The sheet **reuses** `src/components/SshKeysScreen.vue` through the
  existing `androidKeyManager` singleton (`src/platform/android/hosts.ts`), the
  same manager the legacy shell uses. Do not copy the component, do not build a
  second manager, do not invent a new vault API. If the screen needs to look
  different in a sheet, add a prop to it.
- **R33** An empty vault must be **actionable**. `密钥库为空 — 先在密钥页导入一把密钥`
  becomes a control that opens the sheet; the copy must stop naming a page that
  does not exist. A test has to fail if that control is removed — a hint alone is
  the defect being fixed.
- **R34** The sheet is a **stacked view**: Android Back closes the sheet before
  it closes the editor, and the sheet's own action row must be reachable. The
  packaging facts to respect (learned the hard way in T5 of Plan 5):
  `.phone-shell__content { overflow: hidden; padding-bottom: 56px }` and the
  fixed `.AppTabBar` at `z-index: 20` — anything rendered inside the content box
  is clipped by it, and anything below `z-index: 20` sits under the tab bar.
- **R35** **F4.** Every user-facing string on this path is Chinese — the
  editor's validation problems and the dial-failure message. Careful: the
  strings live in code the *shared* app also calls
  (`src/platform/android/hostStore.ts:114-119` is reached from
  `src/sharedApp/hostForm.ts:71`, and `src/stores/connections.ts:393` renders
  the dial failure). Change the **phone shell's** rendering, not the shared
  contract's strings, unless the caller census proves the shared app does not
  use that surface. `tests/unit/releaseChrome.test.ts` guards jargon, not
  language, so this needs its own assertion.
- **R36** **F5.** A field's validation error must not outlive the field it
  complains about: editing any input clears the validation error, while a
  failure that arrived from the list (`props.error` — a rejected save or clear)
  keeps precedence until the user acts.
- **R37** Out of scope: the installed-data migration question
  (`runInstalledDataMigration` reachable only from the unmounted legacy
  `App.vue`) is a **product decision for the maintainer**, not a task here. Do
  not restore `InstalledDataMigrationJourneyTest`, do not mount the legacy shell.
- **R38** Out of scope: hosts that require a reachable SSH server. If no server
  can be stood up on this box, acceptance item 2's connect half and items 3–8
  stay **NOT ACCEPTED** and the record says why. Never mark them PASS.

## Task 1 — the key sheet, reachable from the editor (F3)

**Files likely touched:** `src/components/connections/ConnectionEditor.vue`,
`src/components/SshKeysScreen.vue` (prop, if trimming is needed),
`src/components/connections/ConnectionsList.vue` (pass-through if the sheet is
hosted there instead), `tests/unit/*.test.ts` (new or extended),
`scripts/js-unit-test-manifest.json` (R14.5).

- [ ] **Step 1.** Decide where the sheet lives and write it down in the task
      report: inside `ConnectionEditor.vue` (it owns `form.keyHandleId`) or as a
      sibling in `ConnectionsList.vue`. Ownership of `keyHandleId` and of the
      back-stack entry decides it; do not put a second copy of the form state
      anywhere.
- [ ] **Step 2.** Render `SshKeysScreen` with `:manager="androidKeyManager"`,
      the editor's current key list, `:selected-handle-id="form.keyHandleId"`,
      and `:load-error="keysError"`. Handle `select(handleId)` by setting
      `form.keyHandleId` and returning to the editor; handle `refresh` by
      re-running `listSshKeys()` into `keys`. Do not pass `hostInstall` — there
      is no live connection while the editor is open.
- [ ] **Step 3.** Replace the dead hint with an actionable control
      (R33) that opens the sheet, and keep the hint text honest.
- [ ] **Step 4.** Back behaviour (R34): opening the sheet pushes a stack entry,
      Back pops the sheet and leaves the editor open. Wire it through the
      existing seam the editor already uses (`@update:editor-open` /
      `backStack` in `PhoneApp.vue:124-126`) rather than a new global handler.
- [ ] **Step 5.** Tests, in the existing style (plain `createApp` + jsdom, ONE
      flat top-level `describe` per file, R14.5):
      - opening the sheet from the empty-state control;
      - selecting a key writes the handle and returns to the editor;
      - `refresh` re-lists and a newly imported key appears in the editor's
        `<select>`;
      - Back closes the sheet, not the editor;
      - **the sheet's action row is not behind the tab bar** — assert the DOM
        contract that makes it reachable (a scroll container with a bounded
        height, or a fixed overlay above `z-index: 20`), not a screenshot.
- [ ] **Step 6.** Update `scripts/js-unit-test-manifest.json` from a **fresh JSON
      report** (never hand-typed).

**Review Focus 1** — the empty-state control must be load-bearing: a reviewer
must be able to delete it and see a test go red. A test that only asserts text
is not evidence.

**Review Focus 2** — no fourth tab, no second manager, no copied component
(R31/R32); the diff must not touch `AppTabBar.vue`, `PhoneTab`, or
`TAB_HOME_SURFACE`.

## Task 2 — Chinese copy on this path (F4)

- [ ] **Step 1.** Census every caller of the English strings before changing
      them: `validateSavedHost` (`src/platform/android/hostStore.ts:114`),
      `src/stores/connections.ts:393`, and the editor's own `keysError`
      fallback (`ConnectionEditor.vue:77`). Write the census into the report.
- [ ] **Step 2.** Make the phone shell render Chinese. Preferred shape: split
      the validator into a **problem code** (`'name' | 'hostname' | 'user' |
      'port' | 'key' | null`) plus the existing English sentence as a thin
      wrapper, so shared callers keep byte-identical output; the editor maps
      codes to Chinese. If the census proves the shared app does not use that
      surface, a direct Chinese string is acceptable — say which you chose.
- [ ] **Step 3.** Assertion: a test that goes red if an English sentence
      reappears on the editor's path. `releaseChrome.test.ts` is the precedent
      for a copy guard; extend it or add a sibling with its own scope.

## Task 3 — the error must not outlive its field (F5)

- [ ] **Step 1.** Clear the validation error on any input change, keeping
      `props.error` (a rejected save/clear from the list) taking precedence
      until the user acts (R36).
- [ ] **Step 2.** Test: type an invalid host, submit, see the error, fix the
      field, error gone; and a `props.error` still shows after a local edit until
      the save is retried.

## Task 4 — verify on the packaged app, then record it

- [ ] **Step 1.** `npm run build:android:debug:win`, boot `test` with
      `scripts/start-emulator.ps1`, and walk: 新增连接 → 密钥 → the empty-state
      control → import/generate a key → the key appears → save the host.
      Screenshots into `docs/acceptance/` with the existing numbering.
- [ ] **Step 2.** Update `docs/acceptance/2026-10-19-wechat-ui.md`: item 2's
      "a key host cannot be created at all" is closed — record exactly what was
      and was not proven. Without a reachable SSH server the connect half stays
      NOT ACCEPTED; say so in the row rather than in a footnote.
- [ ] **Step 3.** If a server is available (decision recorded, not assumed):
      `adb reverse` + a local sshd, or the maintainer's host — then items 2 and 8
      can be attempted for real. Do not fabricate.

## Global constraints

- Never weaken a gate to make it pass; retire with a recorded reason.
- No machine-specific absolute paths in the repo.
- Tokens only (no raw colours in `.vue`), ≥48px tap targets, `data-testid` on
  everything a test or a walk touches, Chinese user-facing copy, no PTY/SSH
  jargon in user copy.
- Never `git stash`; never touch `vendor/**`; one flat top-level `describe` per
  unit-test file; manifest titles from a fresh report.
- Commit only after an independent reviewer replies `APPROVED` and the controller
  has re-verified. The controller commits; implementers never do.

## Verification (all of it, before any commit)

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-js-unit-gate.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\android-doctor.ps1
android\gradlew.bat -p android :app:assembleDebugAndroidTest --no-daemon
npm run build:android:debug:win
```

Expected: JS gate = 109 files / 835 tests + the new ones, with the single known
Windows-only red (`sshKeySetup.test.ts:401`) and nothing else; doctor green;
androidTest compiles; APK builds and its packaged version matches what the script
printed. In the packaged walk, item 1 must still pass unchanged.

## Residual (recorded, not done)

**The plugin answers in sentences, so one English clause can still sit inside a
Chinese one.** The Android side of the key vault validates pasted input itself
and rejects it with prose — a pasted public key comes back as *"This is a public
key. Paste the private key instead; it starts with a BEGIN line."* Those
messages cross the boundary as `cause.message`: `src/components/SshKeysScreen.vue`
renders them through `failureMessage(cause, …)` (import, public-key read, copy,
share, delete, install), and `src/components/connections/ConnectionEditor.vue`
renders the vault-read one as `keysError`. F4's JS copy is Chinese; the clause
the native layer contributes is not, and JS cannot translate a sentence it did
not author without parsing English prose.

The fix is for the plugin to return **error codes** (with the message kept for
logs) that the WebView maps to Chinese copy. That is a native-contract change
with its own compatibility question — old APK against new JS, new APK against a
cached bundle — so it is **out of this plan's scope** and is recorded here
rather than attempted inside it.

**The `keyManagement.ts` family is closed (R39).** An earlier revision of this
section treated the plugin's prose as the only English left on this path. That
was wrong: `src/credentials/keyManagement.ts` authored nine error sentences and
two default labels in English, and eight of the nine are reachable from the
phone shell. They are JS-owned and have since been translated (R39, Plan 6 Task
1); the copy guard now asserts on the authoring file, so a move rather than a
translation fails it (R40).

What remains English on this path is therefore two kinds of family:

- **Not JS-owned:** the plugin's prose above, and native-contract validation in
  `src/native/sshKeyVault.ts`.
- **JS-owned but a *contract* family (out of this plan's scope, R41):**
  `src/platform/android/hostStore.ts`'s `MissingHostCredential` (declared at
  `:63`, message at `:68`, thrown at `:246`), the two other English throws in
  that file (`:244`, `:264`), and `UnsupportedHostAuth` in
  `src/credentials/buildSshCredential.ts`. Changing these is a contract change,
  not a translation. The `MissingHostCredential` a user sees arrives through
  `connections.ts:399`/`:417`/`:426` → `ConnectionsList.vue:206`.

Until then the boundary is explicit and enforced: the note at the top of
`tests/unit/connectionCopy.test.ts` names every family that stays English
(native-contract validation in `src/native/sshKeyVault.ts`, plugin sentences
above, and the declared contract exception), and its last tests assert the
boundary still holds — including that a translatable family cannot be added to
the note — so this cannot rot into "F4 was half-done" quietly.
