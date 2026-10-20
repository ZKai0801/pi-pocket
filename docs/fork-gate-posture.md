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
| `build.yml` | Legacy tag artifact build (`push: tags: v*`): derived version, debug + signed release APK, identity/signature validation, artifact upload. Already disabled in GitHub (workflow ID 280774562) | **No.** Its release half needs the same absent secrets; its debug half is duplicated by the two kept workflows | **retired — gated** (`if: false`). Kept on disk as the readable upstream release contract. |

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
retired** (46 dormant unless a group says otherwise; 2 of them were deleted
rather than left dormant, plus one lane-contract test, see §3).

### 2.1 JS unit gate and test validity (22)

| Script | What it guards | Decision — reason |
|---|---|---|
| `run-js-unit-gate.sh` | Runs the whole manifest-registered Vitest suite and hands the JSON report to the checker; fails when `.nvmrc` and the workflow's `node-version` disagree | **kept** — the CI entry point both kept workflows call. |
| `run-js-unit-gate.ps1` | The same gate with `npx`/`python` instead of `pnpm`/`bash`/`python3`, same checker and exit contract | **kept** — the only runnable form on this Windows box (Plan 5 Task 4). |
| `check-js-unit-results.py` | Rejects any file or test title that is not in `scripts/js-unit-test-manifest.json`, in both directions | **kept** — invoked by both gates and `--self-test`ed in both workflows; this is what turns the dropped-file reporter bug into a red gate. |
| `check-test-validity.sh` | Test-validity smells: load-bearing self-skips (A5/A5L/C1), ungated journeys (J1), `Thread.sleep`-as-sync and hand-rolled deadline pumps (TIMING1), unvetted state-injection seams (SEAM1), non-void `@Test` bodies (V1) | **kept, repaired** — its JS J1 delegation was removed with the deleted journeys and the checker behind it; the guard now exits **0** (before this task it exited 1, and the *only* finding was the retired J1 tree). |
| `check-test-validity-selftest.sh` | Synthetic red→green proof of the detectors above, on a throwaway tree | **kept** — still proves the retained app2 J1 rule. Its own run aborts in a C1 fixture with `UnicodeDecodeError: 'gbk' codec …` on this box; that is pre-existing (reproduced from `HEAD`) and Windows-locale-only. |
| `check-unit-gate-wiring.sh` | Asserts the JS unit gate is wired into `.github/workflows/tests.yml` and cannot be skipped | **retired — dormant** — red: `FAIL: workflow not found …/.github/workflows/tests.yml`. That Kotlin-era workflow was hard-cut upstream (#2934); the wiring it checked does not exist. |
| `check-executed-test-counts.sh` | Compares executed test counts against `scripts/executed-test-count-floors.txt` for the Kotlin `test-areas.txt` map | **retired — dormant** — its counts are recorded from lanes (app2/shared) this fork does not have. |
| `check-tests-referenced.sh` | Asserts every test file is named by some harness so no test is silently orphaned | **retired — dormant** — Kotlin-era: there is no `src/androidTest/*.kt` tree left to cross-reference; it also hangs on this box. |
| `check-test-execution-ledger.sh` | Builds/checks the test-execution ledger the nightly release lanes wrote | **retired — dormant** — the lanes that wrote the ledger are gone. |
| `check-test-execution-ledger-wiring.py` | Asserts the ledger is wired into the nightly/release workflows | **retired — dormant** — those workflow steps no longer exist. |
| `check-test-execution-ledger-selftest.sh` | Synthetic proof of the ledger checker | **retired — dormant** — proves a checker whose subject is gone. |
| `check-ci-unit-forced-execution.py` | Asserts the CI unit job force-executes the area map | **retired — dormant** — there is no CI unit job and no area map for this fork. |
| `check-app2-lane-execution.py` | App2 lane execution accounting | **retired — dormant** — `app2/` is not in this checkout. |
| `check-full-jvm-gate-profile.py` | Full-JVM gate profile for the Kotlin Gradle graph | **retired — dormant** — no Kotlin root graph; `scripts/full-jvm-gate.py` only names it. |
| `check-no-native-build.sh` | No Gradle module declares an NDK/CMake native build | **kept — dormant** — it *passes* here (`PASS: no Gradle module declares a native build`) and the property still matters for a Java/Kotlin-only APK. Nothing invokes it; wire it into a kept step before relying on it. |
| `check-file-size-hygiene.sh` | File-size baseline (`file-size-hygiene-baseline.txt`) | **kept — dormant** — the property still applies repo-wide, but it walked >60 s and was killed on this box, so it is unverified here. |
| `check-script-interpreter-hygiene.sh` | Shebang/interpreter hygiene across `scripts/` | **kept — dormant** — same: still applies, unverified here (>40 s probe, killed). |
| `check-product-tmux-absent.sh` | No product tmux surface inside `app2` | **retired — dormant** — red: `missing scan path: app2/build.gradle.kts`. |
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
| `scripts/check-js-first-android-journeys.py` | J1's JS-first half: asserted that each of fifteen packaged lanes dispatched its exact class, methods and result contract. Every one of those classes was deleted by Task 3, so it failed closed ("zero journey-shaped classes") with nothing left to assert. Its two call sites were repaired in the same change. |
| `scripts/check-js-usage-ports-composer-order.py` | Opened `UsagePortsDockerJourneyTest.java` and `PhysicalTap.java` by path — both deleted; it guarded the ordering of a usage/ports screen the phone shell does not have. |
| `tests/scripts/js-first-rewrite-composer-gate-test.sh` | 1,700-line contract test whose whole subject was the workflow wiring of the composer/hotkeys/usage-ports lanes and the gateway-lane action; it asserted the exact workflow steps this task trimmed, so it could only go red. It was the last referrer of the composer-order guard. |

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
   `androidTest` tree is seven files: `DocumentContentIntentTest`,
   `LegacyInstalledDataReaderTest`, `ScriptedImeSelectionTest`, two support
   classes and the scripted IME trio. None is journey-shaped, and none is
   executed by CI. When the phone shell gets an instrumented journey, add the
   lane, the result guard and the J1 dispatch assertion *together*.
3. **`build.yml` / `publish-release.yml`** can be deleted outright once nobody
   needs the upstream release contract readable in-tree; until then `if: false`
   is the honest state.
4. The three guards marked `kept — dormant` in §2.1 should be wired into a kept
   workflow step or explicitly deleted; two of the three could not even be
   verified on this box.
