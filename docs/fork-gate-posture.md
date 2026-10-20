# Fork gate posture

**Scope.** This is the authoritative record of which CI/gate machinery still
applies to **this** checkout — a single-shell (WeChat-style phone shell),
Android-only PocketShell fork on branch `main` — and which machinery was only
ever meaningful for the upstream 0.5.x / Kotlin / shared-shell line. Plan 5 Task
6 produced it; Plan 5 Task 3 (which deleted the `androidTest` journeys) and
Task 4 (which made the JS unit gate runnable on Windows) are its context.

Read this before adding a workflow step, a `scripts/check-*` guard, or an
`androidTest` class. The rule the plan set is the rule here:

> **Do not weaken a gate to make it pass.** A guard that no longer applies is
> *retired with a recorded reason*; a guard that applies and fails is a defect
> to fix.

## Vocabulary

| Decision | Means |
|---|---|
| **kept** | Invoked by a live entry point (a kept workflow step, `npm`, or the Windows gates) and still asserts something this fork ships. |
| **kept — dormant** | The property the script asserts still holds for this fork and the script is *not* retired, but **no live entry point invokes it**, so it guards nothing today. It is a follow-up item, not a green: wire it into a kept step (or delete it deliberately) before anyone cites it, and say whether it was verified on this box. |
| **trimmed** | The *workflow* stays and keeps guarding something real; the inapplicable steps were removed from it. |
| **retired — gated** | The workflow file stays for its documentation value but every job is `if: false` with a pointer here. It can never run. |
| **retired — dormant** | The script stays on disk (something else still names it: another dormant script, a `scripts/*.txt` meta-check or a doc), but no live entry point invokes it. Its subject is gone. |
| **retired — deleted** | Removed from the tree because nothing references it any more. Each deletion is listed with its zero-reference proof in the Task 6 report. |

Nothing in this file is a licence to delete `docs/release.md`, `docs/testing.md`
or the release *derivation* (`scripts/derive-version.sh`,
`scripts/derive-version.mjs`): `versionCode` still comes from it, every build.

---

## Two environment facts this session established

Both are Windows/this-box facts, not code defects. They are recorded here so
nobody re-diagnoses them as regressions.

**1. The Vitest JSON reporter intermittently drops one test file under parallel
execution.** Observed twice during Plan 4/5 on this box: a run reported 107
files where the manifest and a second run reported 108, with two *different*
files omitted (`docs/ci-pitfalls.md` "a gate that silently succeeds" class).
`--no-file-parallelism` makes the JSON report complete and reproducible. That is
why the JS unit gate is run serially here and why a "107 files" report is never
accepted as a green gate: the checker compares the *exact* file and title set
against `scripts/js-unit-test-manifest.json`, so a dropped file fails the gate
instead of hiding. A standard `npx vitest run` on this box reports
109 files / 835 tests — the same set the gate asserts.

**2. `tests/unit/sshKeySetup.test.ts:392` cannot pass on Windows.** The test
asserts a key file is written with mode `0o600`; Windows has no POSIX file
modes, so `stat` reports `0o666` and the assertion fails. This is the single
expected red in the JS unit gate on this box (109 files / 835 tests, 834 passed,
1 failed). It is **documented, not fixed**: the fix would be a
platform-conditional assertion in a test that must keep asserting `0600` on
CI Linux, which remains authoritative. Do not delete the assertion to make the
Windows run green.

A third, related fact: `devBrowserCapacitor.test.ts` "connects, asks for
host-key trust…" takes ~4.9 s alone and hits vitest's 5000 ms default under
full-suite parallel load. Serial execution also fixes that.

**Task 6's Step 3 acceptance was not met, and is not claimed as met.** Step 3
expected the JS unit gate to exit **0** on this box. It exits **1**, and the only
failure is fact 2 above (`tests/unit/sshKeySetup.test.ts:392`, POSIX `0o600` vs
Windows `0o666`). That is the recorded outcome: **acceptance not met — one
documented Windows-only red**, never "green". The gate itself worked (it
collected the exact 109-file / 835-test manifest set and reported 834 passed),
so the red is the platform, not the change; it is not fixed here because the fix
would be a platform-conditional assertion in a test that must keep asserting
`0600` on CI Linux, which stays authoritative.

---

## 1. Workflows (`.github/workflows/`)

Five files. There is **no `origin` remote** on this checkout, so *none* of them
can currently run; the decisions below are about what they would guard if a
remote ever existed, and what a reader should believe when they see one.

| Workflow | What it guarded | Still applies? | Decision — reason |
|---|---|---|---|
| `js-first-rewrite.yml` | JS unit gate, dev-mode shim guard, native close-accounting + unit tests, APK build/identity; plus 15 packaged emulator journey lanes, their result guards, Docker agents lanes and the emulator boot | **Partly.** The gate/build/test half applies; the journey-lane half drove `androidTest` classes deleted by Task 3 | **trimmed (kept)** — the 8 steps that still guard something stay; the journey/emulator/Docker-lane/OCR/quarantine/CI-watcher steps were removed. |
| `js-full-suite.yml` | The same battery on a nightly cron (`17 2 * * *`) so a red `main` cannot go unnoticed (D36) | **Partly**, identical split | **trimmed (kept)** — same trim as `js-first-rewrite.yml`, keeping the D37 wiring its header documents (cron, no path filter, one concurrency group, fail-closed lanes). |
| `js-release-validation.yml` | Produced the exact-SHA "release validation" verdict artifact (24-journey qualification) that the tag-release authorization checker accepts as the only trusted release proof | **No.** It is a `workflow_run` consumer (needs a remote), it qualifies the 24 deleted journeys, and it exists to feed the 0.5.x tag-release chain | **retired — gated** (`if: false`). No remote, no tag line, and its journey subject was deleted. |
| `publish-release.yml` | Authorised a `v*` tag against `main`, built + signed release APKs with Play-style keystore secrets, and created the GitHub Release | **No.** Needs `gh release create --repo PocketShell-io/pocketshell`, a pushed tag, and four signing secrets this checkout does not have; Play-style signing is explicitly out of scope | **retired — gated** (all three jobs `if: false`). The version derivation it used is **kept** — `derive-version` still feeds `versionCode`. |
| `build.yml` | Legacy tag artifact build (`push: tags: v*`): derived version, debug + signed release APK, identity/signature validation, artifact upload. Reported as already disabled in GitHub (workflow ID 280774562) — that is an **inherited claim, unverified**: this checkout has no remote, so the live repository state cannot be read from here | **No.** Its release half needs the same absent secrets; its debug half is duplicated by the two kept workflows | **retired — gated** (`if: false`). Kept on disk as the readable upstream release contract. |

Consequences a reader should expect:

- A green `js-first-rewrite.yml` / `js-full-suite.yml` means: the JS unit suite
  matched its manifest exactly, the dev shims are absent from `dist` and the
  packaged APK, the four native SSH close-accounting regressions ran fresh, the
  native unit tests ran, and the APK's package/version/signature identity
  matched the derived version. It says **nothing** about on-device UI behaviour.
  That acceptance is the packaged APK walk in `docs/acceptance/`.
- `js-release-validation.yml` and `publish-release.yml` showing as "skipped" is
  the intended state, not a misconfiguration.

---

## 2. Scripts

Every `scripts/check-*` and `scripts/run-*` that a workflow, another script or a
`scripts/*.txt` / `scripts/*.json` meta-check still references appears **exactly
once** below, grouped by area. Count: 58 referenced names — **12 kept, 46
retired** (the kept total includes the five `kept — dormant` rows, which are not
green; 46 dormant unless a group says otherwise; 2 of them were deleted rather
than left dormant, plus two lane-contract tests, see §3).

### 2.1 JS unit gate and test validity (22)

| Script | What it guards | Decision — reason |
|---|---|---|
| `run-js-unit-gate.sh` | Runs the whole manifest-registered Vitest suite and hands the JSON report to the checker; fails when `.nvmrc` and the workflow's `node-version` disagree | **kept** — the CI entry point both kept workflows call. |
| `run-js-unit-gate.ps1` | The same gate with `npx`/`python` instead of `pnpm`/`bash`/`python3`, same checker and exit contract | **kept** — the only runnable form on this Windows box (Plan 5 Task 4). |
| `check-js-unit-results.py` | Rejects any file or test title that is not in `scripts/js-unit-test-manifest.json`, in both directions | **kept** — invoked by both gates and `--self-test`ed in both workflows; this is what turns the dropped-file reporter bug into a red gate. |
| `check-test-validity.sh` | Test-validity smells: load-bearing self-skips (A5/A5L/C1), `Thread.sleep`-as-sync and hand-rolled deadline pumps (TIMING1), unvetted state-injection seams (SEAM1), non-void `@Test` bodies (V1) | **kept — dormant; a vacuous green on this tree (measured).** The properties still apply, but the guard scans **nothing** here: `TEST_ROOTS` is `app2/src/androidTest`, `app2/src/test` plus any `shared/*/src/test` — `app2`/`shared` are 0.5.x history, `git ls-files app2 shared` is **empty** — and the collectors only match `*.kt`, while the seven surviving `androidTest` classes are `.java` under `android/app/src/androidTest/java`. Exit 0 therefore means "scanned nothing", not "no smells". Its JS J1 delegation was retired with the deleted journeys; the `--j1-only` entry point now prints a retirement notice and exits 3 and an unknown argument exits 2, so neither can silently pass any more. Nothing invokes it (Task 6 removed its workflow step) — do not cite an exit 0 from it until it is wired to a real `*.kt` tree. |
| `check-test-validity-selftest.sh` | Synthetic red→green proof of the detectors above, on a throwaway tree | **kept — dormant; unverified here — on this box it proves nothing.** Its app2 J1 assertion sits at `:520-525`, but the run aborts earlier, in the C1 stale-baseline fixture at `:460` (`open(src).read()` with no `encoding=` → `UnicodeDecodeError: 'gbk' codec …` on this Windows locale), so that assertion — the only proof the app2 J1 rule ever had here — is **never reached**; and under this non-interactive shell it first stalls in the SIGTERM-cleanup probe, so no detector assertion was measured at all during the fix round. The rule it would prove is 0.5.x history, reachable only from this self-test. Nothing invokes it. |
| `check-unit-gate-wiring.sh` | Asserts the JS unit gate is wired into `.github/workflows/tests.yml` and cannot be skipped | **retired — dormant** — red: `FAIL: workflow not found …/.github/workflows/tests.yml`. That Kotlin-era workflow was hard-cut upstream (#2934); the wiring it checked does not exist. |
| `check-executed-test-counts.sh` | Compares executed test counts against `scripts/executed-test-count-floors.txt` for the Kotlin `test-areas.txt` map | **retired — dormant** — its counts are recorded from app2/shared lanes that are 0.5.x history and absent here. |
| `check-tests-referenced.sh` | Asserts every test file is named by some harness so no test is silently orphaned | **retired — dormant** — Kotlin-era: there is no `src/androidTest/*.kt` tree left to cross-reference; it also hangs on this box. |
| `check-test-execution-ledger.sh` | Builds/checks the test-execution ledger the nightly release lanes wrote | **retired — dormant** — the lanes that wrote the ledger are gone. |
| `check-test-execution-ledger-wiring.py` | Asserts the ledger is wired into the nightly/release workflows | **retired — dormant** — those workflow steps no longer exist. |
| `check-test-execution-ledger-selftest.sh` | Synthetic proof of the ledger checker | **retired — dormant** — proves a checker whose subject is gone. |
| `check-ci-unit-forced-execution.py` | Asserts the CI unit job force-executes the area map | **retired — dormant** — there is no CI unit job and no area map for this fork. |
| `check-app2-lane-execution.py` | App2 lane execution accounting | **retired — dormant** — `app2/` is 0.5.x history and not in this checkout. |
| `check-full-jvm-gate-profile.py` | Full-JVM gate profile for the Kotlin Gradle graph | **retired — dormant** — no Kotlin root graph; `scripts/full-jvm-gate.py` only names it. |
| `check-no-native-build.sh` | No Gradle module declares an NDK/CMake native build | **kept — dormant** — it *passes* here (`PASS: no Gradle module declares a native build`) and the property still matters for a Java/Kotlin-only APK. Nothing invokes it; wire it into a kept step before relying on it. |
| `check-file-size-hygiene.sh` | File-size baseline (`file-size-hygiene-baseline.txt`) | **kept — dormant** — the property still applies repo-wide, but it walked >60 s and was killed on this box, so it is unverified here. |
| `check-script-interpreter-hygiene.sh` | Shebang/interpreter hygiene across `scripts/` | **kept — dormant** — same: still applies, unverified here (>40 s probe, killed). |
| `check-product-tmux-absent.sh` | No product tmux surface inside `app2` | **retired — dormant** — red: `missing scan path: app2/build.gradle.kts` (app2 is 0.5.x history). |
| `check-fixture-errors-file-guard.sh` | Kotlin journey fixture error files | **retired — dormant** — red: `no tracked src/androidTest/*.kt journey sources … a guard that finds nothing to check must not report success`. That message is the correct honest behaviour for a guard whose subject is gone. |
| `check-androidtest-compile-wiring.sh` | Asserts `androidTest` compiles as part of `tests.yml` | **retired — dormant** — red: `workflow not found: …/tests.yml`. |
| `check-no-dev-shims.py` | Dev-only bridge shims are absent from `dist/` and the packaged APK | **kept** — both kept workflows run `--self-test` and the `--dist/--apk` check; the browser dev mode still ships. |
| `check-gate-pipe-buffer-race.sh` | The pipe-buffer race that once truncated a CI log through `tee` | **retired — dormant** — the CI log pipelines it protected are retired with the lanes; only `docs/ci-pitfalls.md` names it. |

### 2.2 APK identity, signing, native unit tests (3)

| Script | What it guards | Decision — reason |
|---|---|---|
| `check-js-apk-metadata.py` | APK package id, `versionCode`, `versionName` against the derived version | **kept** — both kept workflows run `--self-test` plus the real check on `app-debug.apk`. |
| `check-apk-signing.sh` | The debug/release APK is signed by the expected certificate (refuses a silent debug-key fallback for release) | **kept** — the `--variant debug --js-first` path runs in both kept workflows. The release arm is unreachable until release signing is in scope. |
| `run-android-unit-gate.sh` | `:app:testDebugUnitTest` plus a JUnit-XML aggregate that fails on any failure/error | **kept** — both kept workflows run it; this is the gate that covers `RememberedSecretStoreTest` and the rest of the JVM suite. |

### 2.3 Packaged-journey result guards (18) — retired by construction

Every guard here read a JUnit-XML directory produced by one of the fifteen
`scripts/connected-js-*` lanes, each of which selected (via
`-Pandroid.testInstrumentationRunnerArguments.class=`) an `androidTest` class
that **Plan 5 Task 3 deleted**. There is no producer left, and every
`REQUIRED_CLASS` constant now names a class that does not exist — running one
against a stale directory would fail closed on a missing class, which is the
right behaviour and the reason they are dormant rather than "fixed".

| Script | Lane / class it asserted | Decision — reason |
|---|---|---|
| `check-js-smoke-results.py` | `JsShellPackagedSmokeTest` (legacy `App.vue` shell) | **retired — dormant** |
| `check-js-lifecycle-results.py` | `SshPtyDockerJourneyTest` (legacy shell PTY) | **retired — dormant** |
| `check-js-files-results.py` | `J10FilesBrowseEditJourneyTest` (`App.vue` files screen) | **retired — dormant** |
| `check-js-usage-ports-results.py` | `UsagePortsDockerJourneyTest` (usage/ports screens) | **retired — dormant** |
| `check-js-settings-results.py` | `JsSettingsSupportJourneyTest` (settings/diagnostics screens) | **retired — dormant** |
| `check-js-account-sync-results.py` | `AccountSyncJourneyTest` (account sync screen) | **retired — dormant** |
| `check-js-account-picker-results.py` | `SharedAccountPickerJourneyTest` (shared-shell picker) | **retired — dormant** |
| `check-js-account-vault-results.py` | `SharedVaultDockerJourneyTest` (shared-shell vault) | **retired — dormant** |
| `check-js-gateway-results.py` | `GatewayDockerJourneyTest` (gateway lane) | **retired — dormant** |
| `check-js-shared-app-results.py` | `SharedAppDockerJourneyTest` (`src/sharedApp/`) | **retired — dormant** |
| `check-js-key-vault-results.py` | `SshKeyVaultDockerJourneyTest` (`SshKeysScreen` — the plugin survives, the screen does not) | **retired — dormant** |
| `check-js-durable-storage-results.py` | `DurableStorageRestartJourneyTest` (settings/theme/host-snippet screens) | **retired — dormant** |
| `check-js-signed-upgrade-results.py` | `InstalledDataMigrationJourneyTest` (0.5.6 signed upgrade; migration never runs on the phone shell) | **retired — dormant** |
| `check-js-composer-journey-results.py` | `JsComposerDockerJourneyTest` (`PromptComposer`/hotkeys) | **retired — dormant** |
| `check-js-hotkeys-journey-results.py` | `JsFastKeysDockerJourneyTest` (`MobileHotkeys` sheet) | **retired — dormant** |
| `check-js-journey-results.py` | The 24-class *feature* inventory in `scripts/js-journey-class-manifest.json`; BLOCKs at 0/24 and is the release gate's only accepted evidence | **retired — dormant** — all 24 classes are gone, so it can only ever report 0/24; the release chain that consumed it is gated off. |
| `check-android-input-diagnostics.py` | The connected lanes' input-focus failure diagnostics | **retired — dormant** — it describes lanes that no longer run. |
| `check-journey-quarantine-expiry.sh` | Every flake-quarantined journey has an unexpired, issue-backed entry | **retired — dormant** — red here (`2 entry(ies) … need attention`) because `scripts/journey-quarantine.txt` still lists two deleted journeys. The registry has no live subject; emptying it would make the guard vacuously green, which is worse. |

**Deleted, not dormant** (nothing else referenced them after the workflow trim;
see §3): the J1 dispatch checker and the Usage/Ports composer-order guard.
Their replacement is nothing — the surfaces they guarded do not exist.

### 2.4 Docker-lane artifact guards (4)

These verified evidence *produced by* a Docker/packaged lane (host-side JSON,
screenshots, PTY geometry, key-vault artifacts). Subject retired with the lanes;
kept on disk because the lane scripts still name them and the pair is one unit.

| Script | What it guards | Decision — reason |
|---|---|---|
| `check-js-usage-ports-host-evidence.py` | Host-side usage/ports evidence from the usage-ports lane | **retired — dormant** |
| `check-js-lifecycle-host-evidence.py` | Host controller evidence from the lifecycle lane | **retired — dormant** |
| `check-js-hotkeys-pty-geometry.py` | PTY geometry bytes captured by the fast-key lane | **retired — dormant** |
| `check-js-key-vault-artifacts.py` | Key-vault artifacts staged by the key-vault lane | **retired — dormant** |

### 2.5 Emulator / AVD plumbing (1)

The emulator half of the kept workflows was removed: nothing in this fork boots
an AVD in CI, and the acceptance emulator is driven locally by
`scripts/start-emulator.ps1` (Task 5), not by `reactivecircus/android-emulator-runner`.
The AVD pool, lock and disk-pruning helpers (`scripts/avd-pool.sh`,
`scripts/start-local-avd.sh`, `scripts/lib/avd-lock.sh`,
`scripts/ci-emulator-*.sh`) are not `check-*`/`run-*` scripts and are outside
this inventory; they are **retired — dormant** with the lanes they served.

| Script | What it guards | Decision — reason |
|---|---|---|
| `check-emulator-action-pin.sh` | The emulator action is pinned to a reviewed commit SHA | **retired — dormant** — the only file that still names it is the gated `js-release-validation.yml`; the kept workflows no longer use an emulator action, so there is no pin to check. |

### 2.6 Release / publish / nightly (10)

The whole 0.5.x release-verdict chain. Retired with the two gated workflows and
the deleted journeys; dormant rather than deleted because each is named by
another member of the chain or by `docs/release.md`.

| Script | What it guards | Decision — reason |
|---|---|---|
| `check-tag-release-authorization.py` | A release tag is at the current `main` head and carries a green D37 validation artifact | **retired — dormant** — its `--self-test` now fails 2 of 52 checks (default-branch publisher, D37 producer wiring) because it inspects the real workflow files and sees the release jobs gated off. That is the guard correctly reporting "release is not authorised here", not a defect to paper over. |
| `check-release-absence.py` | The GitHub Release does not already exist (create-only publishing) | **retired — dormant** |
| `check-release-gate-bypass-absent.sh` | No input/environment knob can waive the release gate | **retired — dormant** |
| `check-release-gate-execution-profile.sh` | The release gate ran with the intended Gradle/memory profile | **retired — dormant** |
| `check-release-emulator-memory-budget.sh` | The release emulator stayed inside its memory budget | **retired — dormant** |
| `check-release-red-notify-wiring.py` | A red release validation notifies the right channel | **retired — dormant** |
| `check-release-selfheal-wiring.py` | The nightly self-heal path is wired | **retired — dormant** |
| `check-nightly-workflow.sh` | The nightly workflow's schedule/permissions/digest wiring | **retired — dormant** |
| `check-nightly-fault-run.sh` | The nightly fault run executed and reported | **retired — dormant** |
| `run-release-evidence-guards.sh` | Runs the release-evidence guard bundle | **retired — dormant** |

### 2.7 Orphaned guards (zero referrers, pre-existing)

Seven `check-*`/`run-*` scripts had **no** referrer before this task either.
They are not part of the required inventory (nothing references them), they were
not touched, and they are recorded here so the next reader does not mistake them
for live gates: `check-emulator-apk-version-wiring.sh`,
`check-inline-terminal-journey-wiring.rb`, `check-js-composer-host-oracle.py`,
`check-production-binding-mutations.py`, `check-serial-flock-reclaim-probe.sh`,
`check-speech-policy-junit.py`, `run-nightly-guard-selftests.sh`.

---

## 3. What was removed from the tree

Full justifications and the zero-hit greps are in
`.superpowers/sdd/2026-10-19-phone-shell-tabs-chat/plan5-task-6-report.md`.
Short form:

| Path | Why |
|---|---|
| `scripts/check-js-first-android-journeys.py` | J1's JS-first half: asserted that each of fifteen packaged lanes dispatched its exact class, methods and result contract. Every one of those classes was deleted by Task 3, so it failed closed ("zero journey-shaped classes") with nothing left to assert. Its call sites were repaired in the same change — the `exec` of the dispatch checker at `scripts/check-test-validity.sh:190` and its `scan_js_j1` delegation at `:1061`, the self-test invocation at `scripts/check-test-validity-selftest.sh:527`, and the five doc/agent instructions that told people to run the entry point (`.claude/agents/implementer.md`, `.claude/agents/reviewer.md`, `process.md`, `docs/testing.md`, `docs/release.md`; all re-checked in the follow-up fix round). |
| `scripts/check-js-usage-ports-composer-order.py` | Opened `UsagePortsDockerJourneyTest.java` and `PhysicalTap.java` by path — both deleted; it guarded the ordering of a usage/ports screen the phone shell does not have. |
| `tests/scripts/js-first-rewrite-composer-gate-test.sh` | 1,700-line contract test whose whole subject was the workflow wiring of the composer/hotkeys/usage-ports lanes and the gateway-lane action; it asserted the exact workflow steps this task trimmed, so it could only go red. It was the last referrer of the composer-order guard. |
| `tests/scripts/js-first-rewrite-hotkeys-gate-test.sh` | Contract test that asserted *itself* is wired into CI — its `:79` case names its own path among the workflow's steps, i.e. it asserted the very `js-first-rewrite.yml` step Task 6 deleted. Measured **red** before deletion (`FAIL: rewrite fast-key gate inputs are missing`, exit 1) and invoked by nothing otherwise. `docs/superpowers/plans/2026-10-19-phone-shell-tabs-chat.md:1308` already authorised retiring it. |

### 3.1 The rest of the workflow drop (20 paths)

`js-first-rewrite.yml` / `js-full-suite.yml` drop 44 paths between `b5573b8` and
`5d2aa07`. §2 lists the guards among them, §3 above the four removals, the
"deliberately not deleted" note below covers `.github/actions/prepare-gateway-lane`;
the remaining 20 are here so no reader has to re-diff the workflows. None was
deleted in this round, and **none is invoked by a live entry point** — but five
of them are still named by `run:` / `script:` targets in the *gated*
`js-release-validation.yml` (`scripts/agents-pool.sh` at `:190/:193/:437/:441`,
`scripts/ci-js-first-packaged-lanes.sh` at `:239`, which in turn calls the three
`connected-js-*` runners below). That workflow can never run (`if: false`), so
they are dormant rather than broken — but **deleting one of those five means
deleting its gated step in the same change**, or the gated file is left with a
dangling target, which is exactly the defect §3 refuses to introduce for
`prepare-gateway-lane`.

| Path | What it did | Why it went | Still there? |
|---|---|---|---|
| `tests/scripts/connected-test-js-runner-test.sh` | Dispatch contract for `scripts/connected-test.sh` (scratch git repos + stub lanes) | It ran in the "Check JS-first connected-test dispatch and lock contracts" step, whose lanes are gone. Its subject `scripts/connected-test.sh` **still exists**, and `docs/testing.md` still recommends it for a local lane run | yes, uninvoked |
| `tests/scripts/android-input-preflight-test.sh` | Contract for `scripts/lib/android-input-preflight.sh` (#2946) against a stateful fake `adb` | Same removed step. The subject **still exists**, and `docs/testing.md` § "Android input preflight (#2946)" still documents it — note the subject is the `lib/` helper; no `scripts/android-input-preflight.sh` ever existed | yes, uninvoked |
| `tests/scripts/js-fixture-port-lock-test.sh` | Contract for `scripts/lib/js-fixture-port-lock.sh`: one lane owns an agents fixture port at a time | Only lanes take fixture ports, and no lane runs | yes, uninvoked |
| `tests/scripts/avd-lock-test.sh` | Hermetic AVD-lock harness (#1702): inherited acquire state must not short-circuit a fresh gate | Guarded the emulator boot path that was removed | yes, uninvoked |
| `tests/scripts/avd-lock-sharing-test.sh` | Cross-worktree AVD lock sharing (#1657): the lock file must not be per-checkout | Same emulator plumbing | yes, uninvoked |
| `tests/scripts/connected-test-root-guard-test.sh` | `connected-test.sh` must resolve `ROOT_DIR` from its own location, not the caller's cwd (#2500) | It ran beside the lane step; the guard's subject survives, the CI invocation does not | yes, uninvoked |
| `tests/scripts/connected-test-serial-ownership-test.sh` | Serial/AVD ownership between two concurrent lanes (#2863) | Needs two lanes to exist | yes, uninvoked |
| `tests/scripts/shared-app-runner-cleanup-test.sh` | `scripts/connected-js-shared-app.sh` kills its sessions and releases its locks on every exit path (#3002/#2953) | The shared-app lane is retired with the pre-#2936 shared shell | yes, uninvoked |
| `tests/scripts/start-local-avd-launcher-recovery-test.sh` | The emulator start path re-enables a HOME launcher a SIGKILLed lane left disabled (#2946) | CI no longer boots an AVD; local acceptance uses `scripts/start-emulator.ps1` | yes, uninvoked |
| `scripts/test-gradle-output-lock.sh` | Gradle output-tree lock between `connected-test.sh` and the JVM gate (#2007) | Ran in the same removed step; no second concurrent Gradle writer is left in CI | yes, uninvoked |
| `scripts/test-journey-quarantine-non-blocking.sh` | Self-test for the consumption half of flake quarantine (#2355/D36) | The quarantine registry's subject (the deleted journeys) is gone — see `check-journey-quarantine-expiry.sh` in §2.3 | yes, uninvoked |
| `scripts/gateway-lane-fixture.py` | Host-side controller and oracle for the gateway emulator lane (#3086) | Lane retired; the release workflow that also used it is gated | yes, uninvoked |
| `scripts/watch-ci.py` | Token-free, hang-proof Actions run watcher (#952); its `--self-test` was a CI step | Needs a remote, and its `--self-test` wiring was removed with the lanes. Its two default required checks (`JS checks and Android debug APK`, `Docker agents fixture contract`) still exist as jobs — the watcher is not stale, it is simply uninvoked. `process.md` § "Protected `main` checks" still names it **and still says its `--self-test` runs in that job** — that step was removed too | yes, uninvoked |
| `scripts/agents-pool.sh` | Brings Docker agents fixtures up/down on fixed ports for the lanes (2243–2245, `scripts/agents-pool.sh:20`) | No lane uses a fixture port now; `docs/testing.md` still documents the local `up 2244` recipe. Its only remaining caller is the gated `js-release-validation.yml` | yes, uninvoked by a live entry point |
| `scripts/ci-emulator-free-disk.sh` | Frees disk before the API 35 AVD | CI no longer boots an AVD | yes, uninvoked |
| `scripts/ci-emulator-repair-sdk-tools.sh` | Repairs cmdline-tools and accepts licences before the AVD | Same | yes, uninvoked |
| `scripts/ci-js-first-packaged-lanes.sh` | The wrapper that ran the fifteen lanes in order | No lane left to order; still named by the dormant lane scripts and by `docs/testing.md`'s banner | yes — `js-release-validation.yml:239` (`script:`, gated) |
| `scripts/connected-js-smoke.sh` | Smoke lane runner | Its `JsShellPackagedSmokeTest` was deleted | yes — called only by the wrapper above |
| `scripts/connected-js-files-docker.sh` | Files lane runner | Its `J10FilesBrowseEditJourneyTest` was deleted | yes — called only by the wrapper above |
| `scripts/connected-js-key-vault-docker.sh` | Key-vault lane runner | Its `SshKeyVaultDockerJourneyTest` was deleted | yes — called only by the wrapper above |

Deliberately **not** deleted, and why:

- The fifteen `scripts/connected-js-*` lanes and
  `scripts/ci-js-first-packaged-lanes.sh`: each is still named by another
  dormant lane/guard or by `docs/testing.md`, and deleting the cluster would
  have required rewriting the packaged-lane chapter of a doc that also
  describes gates that still run. They are **retired — dormant**; a banner at
  the head of that chapter points here.
- `.github/actions/prepare-gateway-lane`: referenced only by the gated release
  workflow now, so deleting it would leave a dangling `uses:` there.
- Release derivation (`scripts/derive-version.sh`, `scripts/derive-version.mjs`):
  `versionCode`/`versionName` still come from it for every build.

## 4. Follow-ups (recorded, not done)

1. **Delete the dormant packaged-lane cluster** in one change:
   `scripts/connected-js-*.sh`, `scripts/ci-js-first-packaged-lanes.sh`, the
   result guards in §2.3/§2.4, `scripts/js-journey-class-manifest.json`,
   `scripts/journey-quarantine.txt`, the AVD/docker plumbing, and the
   `docs/testing.md` chapter. It is a large, self-contained deletion with no
   live consumer; it was out of scope for a posture task, and the alternative —
   half-deleting it — would have left exactly the dangling references the plan
   forbids.
2. **Re-add a packaged journey lane only with a phone-shell journey.** The kept
   `androidTest` tree is **ten tracked files: seven `.java`** —
   `DocumentContentIntentTest`, `LegacyInstalledDataReaderTest`,
   `ScriptedImeSelectionTest`, plus their helpers `GeneratedSshKeyTestSupport`,
   `SshKeyVaultTestSupport`, `ScriptedIme` and `ScriptedTestIme` — **plus**
   `AndroidManifest.xml`, `assets/terminal-logical-lines.js` and
   `res/xml/scripted_test_ime.xml`. None is journey-shaped, and none is
   executed by CI. When the phone shell gets an instrumented journey, add the
   lane, the result guard and the J1 dispatch assertion *together*.
3. **`build.yml` / `publish-release.yml`** can be deleted outright once nobody
   needs the upstream release contract readable in-tree; until then `if: false`
   is the honest state.
4. The **five** guards marked `kept — dormant` in §2.1 —
   `check-test-validity.sh`, `check-test-validity-selftest.sh`,
   `check-no-native-build.sh`, `check-file-size-hygiene.sh`,
   `check-script-interpreter-hygiene.sh` — should each be wired into a kept
   workflow step or explicitly deleted. None is verified on this box: the first
   scans no test source at all, the self-test cannot complete, and the other
   three are either over the time budget or simply never invoked.
