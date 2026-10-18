# PocketShell WeChat-UI Rebuild — Plan 5: Build path, reduced gate, emulator acceptance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a real, installed, launched APK on an Android emulator from
this Windows checkout, and cut the upstream gate apparatus down to one that
actually applies to a single-shell, Android-only fork — so every later change has
a green signal that means something.

**Architecture:** The repo's build entry points are POSIX (`./android/gradlew`,
`derive-version.sh`, `run-js-unit-gate.sh`) and this box has no `bash` (and no
`pnpm`). This plan adds a first-class Windows path that does not depend on either,
retires the gates that only served the deleted shared shell / 0.5.x line, and
then uses the resulting build to accept the UI on a packaged APK.

**Tech Stack:** Gradle 8.14.3 (wrapper), AGP 8.13.0, compileSdk/targetSdk 36,
minSdk 26, JDK 21, Node 25 + npm, `android\gradlew.bat`, `adb`.

**Spec:** `docs/superpowers/specs/2026-10-19-wechat-ui-pi-design.md` (§11, §12)
**Predecessor:** `docs/superpowers/plans/2026-10-19-native-credentials.md`

## Verified build facts

- `android/gradle/wrapper/gradle-wrapper.properties` → gradle **8.14.3**.
- `android/build.gradle:10` → AGP **8.13.0**; `android/variables.gradle:2-4` →
  minSdk 24 / compileSdk **36** / targetSdk **36**; `android/app/build.gradle:126-127`
  overrides to minSdk **26** / targetSdk **35**; `versionCode`/`versionName` come
  from `derive-version.sh` (bash).
- `android\gradlew.bat` **exists**; `android/gradlew` is the POSIX twin.
- `package.json` scripts are POSIX: `build:android:debug` ends in
  `./android/gradlew -p android assembleDebug`, and `build:web` calls
  `pnpm verify:js-source` (needs `pnpm`).
- `.github/workflows/` holds `build.yml`, `js-first-rewrite.yml`,
  `js-full-suite.yml`, `js-release-validation.yml`, `publish-release.yml`;
  `scripts/` holds ~150 guard scripts, several of which assert on the files this
  rebuild deletes (`check-executed-test-counts.sh`, `check-tests-referenced.sh`,
  `check-unit-gate-wiring.sh`, `check-file-size-hygiene.sh`, `check-no-native-build.sh`).
- `android/app/src/androidTest/...` contains journey tests bound to the deleted
  shared shell (`SharedShellLaunch.java`, `SharedAppDockerJourneyTest.java`,
  `SharedAccountPickerJourneyTest.java`, `SharedVaultDockerJourneyTest.java`, …).
- There is **no** `origin` remote on this checkout.

## Global Constraints

- **Do not weaken a gate to make it pass.** A guard that no longer applies is
  **retired with a recorded reason**; a guard that applies and fails is fixed.
  The distinction is written into `docs/fork-gate-posture.md` by Task 6.
- **No secret and no machine-specific absolute path in the repo.** The toolchain
  paths are discovered and written to a git-ignored local file, not committed.
- **The packaged APK is the acceptance** (AGENTS.md): a Vite dev-server render is
  a fast pre-check only.
- **Never run `tmux kill-server`**; this plan touches no tmux state.
- **Do not `rm` a path containing `$`** (AGENTS.md): resolve globs in a separate
  command first.
- Everything added must work on Windows **without bash**, since none is present.

## Review Focus

1. The version-derivation fallback must produce a **stable, valid** Android
   version, not an empty string: `versionCode` empty makes `assembleDebug` fail
   with a confusing manifest error.
2. Retiring a workflow/guard must not leave a **dangling reference** — a workflow
   that calls a deleted script, or a `check-*` still listed in a meta-check.
3. The JS unit gate must be runnable end-to-end on this box; a gate that only
   runs in CI is how a red `main` goes unnoticed.
4. Acceptance evidence must include the **real in-session screen** with the
   keyboard up where relevant, not only isolated component renders (AGENTS.md).

---

### Task 1: Toolchain doctor

**Files:**
- Create: `scripts/android-doctor.ps1`
- Create: `.local/toolchain.json` (git-ignored)

**Interfaces:**
- Produces: `scripts/android-doctor.ps1 -Write` resolves and records
  `{ javaHome, sdkRoot, adb, emulator, avdName }`.

- [ ] **Step 1: Write the doctor script**

Detect and report, failing loudly when missing: a JDK **21** (`JAVA_HOME` →
`where.exe java` → a search of the usual install roots), `ANDROID_HOME`/
`ANDROID_SDK_ROOT` with `platforms\android-36`, `build-tools\36.0.0`,
`platform-tools\adb.exe`, `emulator\emulator.exe`, at least one
`system-images\android-35\google_apis\x86_64`, and an AVD named `test`. Print a
one-line verdict per item and exit non-zero if any is missing, naming the exact
`sdkmanager`/`avdmanager` command to fix it.

- [ ] **Step 2: Run it and resolve what it reports**

Run: `powershell -File scripts/android-doctor.ps1`
Expected: a full report. Install whatever it reports missing via
`<sdkRoot>\cmdline-tools\latest\bin\sdkmanager.bat "platforms;android-36" "build-tools;36.0.0" "system-images;android-35;google_apis;x86_64" "emulator" "platform-tools"`
and a JDK 21 (`winget install Microsoft.OpenJDK.21` or `EclipseAdoptium.Temurin.21`),
then re-run until clean. If installation is impossible in this environment, stop
here and report the blocker — **do not** fabricate an APK result.

- [ ] **Step 3: Record the resolved paths**

Run: `powershell -File scripts/android-doctor.ps1 -Write`
Expected: `.local/toolchain.json` written; confirm it is ignored:
Run: `git status --porcelain`
Expected: no `.local/` entry (add `.local/` to `.gitignore` if it appears).

- [ ] **Step 4: Commit**

```bash
git add scripts/android-doctor.ps1 .gitignore
git commit -m "chore(android): a toolchain doctor and a git-ignored local config"
```

---

### Task 2: A bash-free debug build

**Files:**
- Create: `scripts/build-android-debug.ps1`
- Modify: `package.json`

**Interfaces:**
- Produces: `scripts/build-android-debug.ps1` performing
  web build → `cap sync` → `android\gradlew.bat -p android assembleDebug`, and
  `pnpm build:android:debug` delegating to it.

- [ ] **Step 1: Write the script**

Resolve `JAVA_HOME`/`ANDROID_HOME` from `.local/toolchain.json` (Task 1) or the
environment, then run, in order, failing on the first error: `npx vite build`
after `node scripts/verify-js-source.mjs` and `npx vue-tsc --noEmit` (the `pnpm`
script bodies, invoked directly since there is no `pnpm`), `npx cap sync android`,
`derive-version` (see Step 2), and
`& android\gradlew.bat -p android assembleDebug --console=plain`. Print the
resulting APK path (`android\app\build\outputs\apk\debug\app-debug.apk`) and its
SHA-256.

- [ ] **Step 2: Replace the bash-only version derivation**

`android/app/build.gradle:129-130` reads `pocketShellVersion` from
`derive-version.sh`, which needs bash. Add a Node equivalent
(`scripts/derive-version.mjs`) that reproduces the same inputs
(`git describe --tags --dirty --always`, a `0.0.0-dev` fallback when git or tags
are unavailable) and have the script call it. The fallback must be a **stable**
valid pair — Review Focus 1: verify a versionCode ≥ 1 is always produced, and
assert it in the script rather than trusting the fallback.

- [ ] **Step 3: Wire the npm script and prove it**

Add `"build:android:debug:win": "powershell -File scripts/build-android-debug.ps1"`
and keep the existing POSIX script for other platforms.

Run: `npm run build:android:debug:win`
Expected: `BUILD SUCCESSFUL` and an APK on disk.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-android-debug.ps1 scripts/derive-version.mjs package.json
git commit -m "chore(android): a bash-free Windows debug build path"
```

---

### Task 3: Make the Android test sources compile

**Files:**
- Delete: the shared-shell `androidTest` journey tests and their `SshKeyVaultDockerJourneyTest`-style Docker dependencies, plus `SharedShellLaunch.java`, `SharedAppDockerJourneyTest.java`, `SharedAccountPickerJourneyTest.java`, `SharedVaultDockerJourneyTest.java`, `AccountSyncJourneyTest.java` and any other test referencing a removed surface
- Modify: `android/app/build.gradle` if a deleted directory empties a source set

- [ ] **Step 1: Find what breaks**

Run: `& android\gradlew.bat -p android assembleDebugAndroidTest --console=plain`
Expected: FAIL, listing the compile errors from the shared-shell tests — this is
the work list.

- [ ] **Step 2: Delete the tests bound to removed code**

Delete each test listed in the failure that exercises a deleted screen, plugin or
shell; delete its helper/support class too. Keep `SshKeyVaultTestSupport.java`
and `GeneratedSshKeyTestSupport.java` — the key vault survives. Delete the Docker
JS-lane scripts for removed surfaces
(`scripts/connected-js-{shared-app,account-sync,account-picker,account-vault,files,hotkeys,usage-ports,settings,voice-settings}.sh`)
and any `androidTest` they support

- [ ] **Step 3: Re-run until it compiles**

Run: `& android\gradlew.bat -p android assembleDebugAndroidTest --console=plain`
Expected: `BUILD SUCCESSFUL`.

Run: `& android\gradlew.bat -p android testDebugUnitTest --console=plain`
Expected: `BUILD SUCCESSFUL` including Plan 4's `RememberedSecretStoreTest`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(android): drop journey tests bound to the removed shared shell"
```

---

### Task 4: A runnable JS unit gate

**Files:**
- Create: `scripts/run-js-unit-gate.ps1`
- Modify: `scripts/js-unit-test-manifest.json` (finish the Plan 2 reconciliation)

**Interfaces:**
- Produces: `scripts/run-js-unit-gate.ps1` running the exact manifest-registered
  suite and checking the result, with no bash and no `pnpm`.

- [ ] **Step 1: Write the gate runner**

Run the registered files with `npx vitest run --reporter=json --outputFile=...`,
then invoke `python scripts/check-js-unit-results.py --report <path>`. Exit with
the checker's code. If `python` is absent, fail with an explicit message rather
than passing vacuously — a gate that silently succeeds is the failure mode
`docs/ci-pitfalls.md` warns about.

- [ ] **Step 2: Verify it fails closed**

Temporarily add a `tests/unit/scratch.test.ts` with one trivial test.
Run: `powershell -File scripts/run-js-unit-gate.ps1`
Expected: FAIL — the checker rejects a file that is not in the manifest.
Delete the scratch file and re-run: expected exit 0.

- [ ] **Step 3: Confirm the manifest covers the new suites**

Confirm `tests/unit/{pi*,hostStoreV2,buildSshCredential,rememberedSecrets,connections*,projectsStore,sessionsStore,sessionsSend,chatMarkdown,phoneTokens,shellCleanup,phoneShellSingleEntry,terminalScreenWiring,createSession,piTurnRunner,piResolveCommand,piResolveSessionRoot,piTransport,turnCompletion,piTurnCommand}.test.ts`
are all registered, collapsing each multi-`describe` file under one top-level
`describe` as Plan 2 Task 10 established.

Run: `powershell -File scripts/run-js-unit-gate.ps1`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/run-js-unit-gate.ps1 scripts/js-unit-test-manifest.json
git commit -m "chore(ci): a bash-free JS unit gate for this fork"
```

---

### Task 5: Emulator acceptance

**Files:**
- Create: `scripts/start-emulator.ps1`
- Create: `docs/acceptance/2026-10-19-wechat-ui.md` (evidence)

- [ ] **Step 1: Boot the AVD and install**

Start the `test` AVD (`emulator.exe -avd test -no-snapshot -gpu swiftshader_indirect`),
wait for `adb wait-for-device` + `getprop sys.boot_completed`, then
`adb install -r android\app\build\outputs\apk\debug\app-debug.apk` and launch the
activity. Do not kill a pre-existing emulator to "clean up".

- [ ] **Step 2: Walk the acceptance list on the packaged APK**

Against the packaged build (not a dev-server render), and with a real host
configured (the maintainer's `kai-server-local` credentials come from the
maintainer — if they are unavailable, record these as **not yet accepted**
rather than marking them done):

1. App opens on the Connections tab; the bottom bar shows 连接 / 项目 / 会话.
2. 新增连接 saves a key host; connecting shows the host-key prompt on first use
   and then the connected state.
3. The 项目 tab lists Pi projects; the search box filters; pull-to-refresh works.
4. Opening a project lists its sessions with titles and previews; opening one
   shows the chat as WeChat bubbles — user right/green, assistant left/white,
   tool calls and thinking **absent**.
5. Sending a message produces a reply, and the sent text survives a failed send.
6. 打开终端 attaches the terminal and survives a reconnect.
7. Password auth: add a host with 密码, connect, and confirm no prompt on a
   second connect with 记住密码 on.
8. A passphrase-protected key connects without re-prompting the passphrase.

- [ ] **Step 2a: Capture evidence**

For each item, capture the **real in-session screenshot** with the keyboard up
where the report concerns the keyboard, and paste it into
`docs/acceptance/2026-10-19-wechat-ui.md` with the item number. Then compare the
chat screen side by side with the mockup in the spec (§5) — a green component
render is not the acceptance (AGENTS.md).

- [ ] **Step 3: Record the result honestly**

Write each item as PASS / FAIL / NOT ACCEPTED with the screenshot and the exact
build SHA-256. List every FAIL as a follow-up issue rather than editing the spec
to match.

- [ ] **Step 4: Commit**

```bash
git add scripts/start-emulator.ps1 docs/acceptance/2026-10-19-wechat-ui.md
git commit -m "docs(acceptance): packaged-APK acceptance for the WeChat UI"
```

---

### Task 6: Record the fork's gate posture

**Files:**
- Create: `docs/fork-gate-posture.md`
- Modify: `.github/workflows/*` (retire what cannot apply)

- [ ] **Step 1: Inventory**

For every workflow in `.github/workflows/` and every `scripts/check-*.sh` still
referenced by one, write one line: what it guards, whether it still applies, and
  the decision (kept / retired + reason). The retired-by-construction set is at
  least the Kotlin-era release lanes and anything asserting the shared shell or
  the deleted screens.

- [ ] **Step 2: Retire, don't delete blindly**

For each retired workflow, either delete the file or gate it off with an explicit
`if: false` plus a comment pointing at the posture doc — and delete any script
that only it invoked. Then grep for dangling references: for every script name
removed, no remaining workflow, meta-check or doc may reference it (Review Focus
2).

- [ ] **Step 3: Verify no dangling reference and the kept gate is green**

Run: `powershell -File scripts/run-js-unit-gate.ps1`
Expected: exit 0.
Run: `npm run build:android:debug:win`
Expected: `BUILD SUCCESSFUL`.
Cross-check the posture doc's "kept" list against the workflows that still
reference live scripts.

- [ ] **Step 4: Commit**

```bash
git add docs/fork-gate-posture.md .github/workflows scripts
git commit -m "docs(ci): record the fork's gate posture and retire inapplicable checks"
```

---

## Self-Review

- **Spec coverage:** §11 (build/verification path) → Tasks 1, 2, 5; §12 (evidence)
  → Task 5; the "unused content may be deleted" mandate applied to the test/CI
  layer → Tasks 3, 6.
- **Review Focus:** RF1 → Task 2 Step 2; RF2 → Task 6 Step 2; RF3 → Task 4;
  RF4 → Task 5 Step 2a.
- **Dependencies:** Task 5 needs Task 2's APK and Plan 4's native work compiled;
  Task 3 needs Plan 2's deletions to have landed; Task 1 blocks Tasks 2, 3 and 5.
- **Explicitly out of scope:** re-enabling CI on a remote (there is no `origin`),
  Play-style release signing, and the 0.5.x/release machinery.
- **Honesty gate:** every task that needs this machine's toolchain fails loudly
  and names the fix; none may report success it did not observe.

## Plan set complete

1. `2026-10-19-pi-foundation-data-layer.md` — **done**
2. `2026-10-19-phone-shell-tabs-chat.md`
3. `2026-10-19-chat-send-pty-turn.md`
4. `2026-10-19-native-credentials.md`
5. `2026-10-19-cleanup-android-acceptance.md` — this file
