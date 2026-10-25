# Chat-Only Phone App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the terminal surface, all aplexer/host-CLI consumption, and the unreachable legacy shell from the phone app, leaving a pi-chat-only client whose host contract is SSH + `pi` (+ recommended tmux).

**Architecture:** Pure deletion in this repo. The live entry (`src/main.ts` → `src/phone/PhoneApp.vue`) loses its terminal screen and wiring; `src/platform/android/connectionHub.ts` loses its attach/session-listing machinery while keeping the channels chat rides (exec, SFTP, forwards, reconnect/grace, and the `sshCapability.openPty` path the turn runner uses); the legacy `App.vue` shell and the browser-dev mock are trimmed to match. `vendor/pocketshell-core` is NOT modified.

**Tech Stack:** Vue 3 + TypeScript, Capacitor (Android), Vitest (`scripts/run-js-unit-gate.sh`), PowerShell build script.

**Spec:** `docs/superpowers/specs/2026-10-25-chat-only-phone-app-design.md`

## Global Constraints

- **Implementers never commit** (process.md). Every task below ends with green checks and a report — no `git commit` steps. Commits happen once, from the orchestrator, after reviewer APPROVED and the maintainer's APK verdict.
- **D22 hard cut:** no flag, no hidden path, no "keep for now" dead code. If a file's only consumers are deleted, the file goes in the same task.
- **The core submodule is frozen:** never edit `vendor/pocketshell-core/**`. The phone app simply stops importing the surfaces it no longer needs.
- **Unit gate:** `scripts/run-js-unit-gate.sh` must be green at the end of every task. **Typecheck:** `pnpm typecheck` likewise.
- **Test manifest (G9):** the gate fails unless every file and test title registered in `scripts/js-unit-test-manifest.json` actually ran. Every task that deletes or trims a test file must remove its entries from that manifest in the SAME task; Task 4 registers its new test there.
- **Chat is untouchable:** `src/pi/**`, `src/stores/sessions.ts`, `src/stores/projects.ts`, the turn runner seam (`src/session/turnPty.ts`, PhoneApp's `sshCapability.openPty` call at `src/phone/PhoneApp.vue:584`), `src/session/composerDelivery.ts` — none of these files is deleted or behaviorally changed by this plan. If a task seems to require touching them, stop and report instead.
- Docs are English. User-facing strings stay in the existing i18n shape (`src/i18n/messages.ts`).
- Build the APK with `scripts/build-android-debug.ps1` (Windows box), after `git submodule update --init --recursive` and `pnpm install --frozen-lockfile`.

---

### Task 1: Delete the unreachable legacy shell

**Files:**
- Delete: `src/App.vue`, `src/legacyMain.ts`
- Delete (legacy-exclusive screens, verified below): `src/components/SettingsScreen.vue`, `src/components/ProviderUsageScreen.vue`
- Modify: `src/destinationInventory.ts`, `tests/unit/durableStorage.test.ts`, `tests/unit/usageDockerFixture.test.ts` (delete), plus any test that imports `App.vue`
- Test: `scripts/run-js-unit-gate.sh`, `pnpm typecheck`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a repo where `src/App.vue` and every file only it imports is gone; later tasks' grep audits no longer hit legacy noise.

- [ ] **Step 1: Inventory legacy-exclusive imports**

Run from the repo root:

```bash
grep -rn "from '.*App.vue'" src/ tests/ --include="*.ts" --include="*.vue" | grep -v PhoneApp
grep -rn "legacyMain" src/ tests/ scripts/ vite.config.* index.html 2>/dev/null
for f in SettingsScreen ProviderUsageScreen TerminalViewport hostKeyCard destinationInventory buildDiagnostics sessionAgentMetadata; do
  echo "== $f =="; grep -rln "$f" src/ tests/ --include="*.ts" --include="*.vue" | grep -v "components/$f.vue"
done
```

Decision rule: a file under `src/components/` or `src/session/` is **legacy-exclusive** if the only non-test importer listed is `src/App.vue` (or `src/legacyMain.ts`). Record the final delete list in the task report. Files known (spec-time) to have live consumers besides `App.vue` — `src/session/hostKeyCard.ts` is also imported by PhoneApp's trust flow: check before deleting; if it has a live consumer it stays. `src/components/TerminalViewport.vue` is ALSO used by `TerminalScreen.vue` — do NOT delete it in this task; Task 2 owns it.

- [ ] **Step 2: Delete the files**

Delete `src/App.vue`, `src/legacyMain.ts`, and the legacy-exclusive files Step 1 identified (certainly `src/components/SettingsScreen.vue`, `src/components/ProviderUsageScreen.vue`, `tests/unit/usageDockerFixture.test.ts`).

- [ ] **Step 3: Fix the referencing tests**

`tests/unit/durableStorage.test.ts` names `legacyMain` in a string. Read the assertion: if it asserts the legacy entry exists, invert it to assert the legacy entry is gone (the durable-storage behavior itself must keep its coverage — keep the assertions about storage semantics, drop the ones about the legacy entry). For every other test Step 1 listed importing `App.vue`: delete the test file if its whole subject was the legacy shell, else delete only its legacy-shell cases.

- [ ] **Step 4: Update `src/destinationInventory.ts`**

For each entry whose `oldDestination`/`newRoute` belonged only to the legacy shell (at least the `usage` routes at lines 23-24), set `status: 'removed'` and `note: 'Removed with the legacy shell and the chat-only cut (2026-10-25 spec).'`. Keep entries for routes that still exist.

- [ ] **Step 5: Remove deleted tests from the manifest**

Delete the manifest entries for every test file removed in Steps 2-3 (certainly `usageDockerFixture.test.ts`, plus any legacy-shell test file) from `scripts/js-unit-test-manifest.json`.

- [ ] **Step 6: Verify**

```bash
pnpm typecheck && scripts/run-js-unit-gate.sh
```

Expected: both green. Report the deleted-file list.

---

### Task 2: Remove the terminal surface from the phone shell

**Files:**
- Delete: `src/components/terminal/TerminalScreen.vue`, `src/components/TerminalViewport.vue`, `src/session/terminalPty.ts`
- Delete (if Step 1 confirms terminal-exclusive): `src/session/terminalFocus.ts`, `src/session/attachAutofocusTestGate.ts`, `src/session/agentMetadata.ts`
- Modify: `src/phone/PhoneApp.vue`, `src/i18n/messages.ts`
- Delete tests: `tests/unit/terminal-geometry.test.ts`, `tests/unit/terminal-viewport-resize.test.ts`, `tests/unit/terminalDictationBarUnmount.test.ts`, `tests/unit/terminalFocus.test.ts`, `tests/unit/terminalImeInput.test.ts`, `tests/unit/terminalLogicalLines.test.ts`, `tests/unit/terminalScreenWiring.test.ts`, `tests/unit/terminalUtf8.test.ts`, `tests/unit/sessionAgentMetadata.test.ts`
- Test: `scripts/run-js-unit-gate.sh`, `pnpm typecheck`

**Interfaces:**
- Consumes: Task 1 (legacy shell gone, so TerminalViewport has no other consumer).
- Produces: PhoneApp no longer exports/installs any terminal PTY seam — Task 3 deletes the hub machinery that existed to serve it.

- [ ] **Step 1: Confirm the helper files are terminal-exclusive**

```bash
for f in terminalFocus attachAutofocusTestGate agentMetadata; do
  echo "== $f =="; grep -rln "session/$f" src/ tests/ --include="*.ts" --include="*.vue"
done
grep -rln "terminalPty" src/ tests/ --include="*.ts" --include="*.vue"
```

Decision rule: delete `src/session/<file>.ts` when its importers are only `TerminalScreen.vue`, `TerminalViewport.vue`, `App.vue` (already gone), and tests. If `agentMetadata.ts` turns out to have a live chat consumer, it stays and its test stays — record which way it went.

- [ ] **Step 2: Strip PhoneApp's terminal wiring**

In `src/phone/PhoneApp.vue` remove: the `TerminalScreen` import (line ~30) and its `<TerminalScreen …>` mount (~line 1005); the `installTerminalPty` import (~line 62) and call (~line 318) plus the matching uninstall on unmount; the whole `terminalPtyImplementation` object (~lines 677-690) including `findSessionRow` and the `SessionRow` type import if nothing else uses it; any terminal tab/route/button state that existed only to open the terminal screen. The comment block at ~lines 218-231 about turn/tmux survival belongs to the turn runner — keep it with the turn code.

- [ ] **Step 3: Delete the files and tests listed above**

- [ ] **Step 4: Trim i18n**

In `src/i18n/messages.ts`, delete the keys whose only consumer was the terminal screen (grep each candidate key; keep any used by chat/settings/connections).

- [ ] **Step 5: Adapt the shell tests**

```bash
grep -rln "TerminalScreen\|terminalPty\|TerminalViewport" tests/unit/
```

For each hit (expected: `phoneShellWiring.test.ts`, `phoneShellSingleEntry.test.ts`, possibly `releaseChrome.test.ts`, `mobileHotkeys.test.ts`, `backNavigation.test.ts`): delete the terminal-specific cases; keep every chat/connections/settings case. A test file whose entire subject was the terminal screen goes entirely.

- [ ] **Step 6: Remove deleted tests from the manifest**

Remove the entries for the nine terminal test files (and `sessionAgentMetadata.test.ts` if deleted, and any shell test file removed wholesale) from `scripts/js-unit-test-manifest.json`. For shell tests you trimmed rather than deleted, remove only the deleted test titles.

- [ ] **Step 7: Verify**

```bash
pnpm typecheck && scripts/run-js-unit-gate.sh
```

Expected: both green, no surviving import of `terminalPty` anywhere:

```bash
grep -rn "terminalPty\|TerminalScreen\|TerminalViewport" src/ tests/ | wc -l   # 0
```

---

### Task 3: Strip the connectionHub's attach machinery

**Files:**
- Modify: `src/platform/android/connectionHub.ts` (684 lines), `src/platform/android/androidApi.ts`
- Test: `tests/unit/multiPtyHub.test.ts` (adapt), `scripts/run-js-unit-gate.sh`, `pnpm typecheck`

**Interfaces:**
- Consumes: Task 2 (no remaining caller of attach).
- Produces: the hub keeps exactly these public members (names Task 4 and the guard test rely on): `exec(connectionId, command, timeoutMs)`, the PTY-channel primitives that `androidApi.ts`'s `sshCapability.openPty` rides, SFTP/forward plumbing, `connectionStateFor(snapshot)` (keep — it maps core's snapshot for the live connection UI), reconnect/grace paths. Deleted members: `attachSession`, `input(shellId, …)`, `sessionsList`, `sessionsProbe`, `hostCommand`, `subscribeTerminalOutput`, the `AttachRequest`/`PendingAttach`/`ShellBinding`/`retired` state and `sameRow`.

- [ ] **Step 1: Map what openPty actually rides**

Before deleting anything, establish the boundary with:

```bash
grep -n "openPty" src/platform/android/androidApi.ts src/phone/PhoneApp.vue
grep -n "shellId\|ShellId" src/platform/android/androidApi.ts | head -20
sed -n '380,430p' src/platform/android/androidApi.ts
```

`src/phone/PhoneApp.vue:584` calls `sshCapability.openPty({...})`; `androidApi.ts` ~397 implements it ("One PTY per controller"). Whatever channel bookkeeping that path uses (shell-id allocation, data pumps) STAYS, shared with nothing removed. Write the kept/deleted member list into the task report before editing.

- [ ] **Step 2: Delete the attach-only machinery**

In `connectionHub.ts`: remove `AttachRequest` (line ~66), `PendingAttach`, `ShellBinding`, the `attaching`/`retired` maps, `sameRow`, `attachSession` (~360), `input` (~418), `sessionsList` (~339), `sessionsProbe` (~352), `hostCommand` (~316), the `subscribeTerminalOutput` subscription (~265) and its aplexer-snapshot repaint logic (~266-280), and the now-unused imports (`SessionRow`, `SessionSummary`, `HostCliExecOutcome` — only if nothing else in the file uses them). In `androidApi.ts`: remove the `sessionsList`/`sessionsProbe`/`hostCommand` bridge wiring (~lines 406-407 and the `hostCommand` bridge) and any attach-related capability surface. Keep `exec`, SFTP, forwards, `openPty`.

- [ ] **Step 3: Adapt `tests/unit/multiPtyHub.test.ts`**

Delete every case that drives `attachSession`/`sessionsList`/terminal output subscription. Keep and (if needed) rename the cases covering `openPty`-style PTY lifecycle, exec, and reconnect behavior — these are the chat path's regression cover. If the file's whole subject was attach, delete it and say so in the report.

- [ ] **Step 4: Sweep remaining references**

```bash
grep -rn "attachSession\|sessionsProbe\|hostCommand\|subscribeTerminalOutput\|AttachRequest" src/ tests/ --include="*.ts" --include="*.vue"
```

Expected after fixes: 0 hits.

- [ ] **Step 5: Verify**

```bash
pnpm typecheck && scripts/run-js-unit-gate.sh
```

Reconnect/grace suites (`connectionResume.test.ts`, `sharedRecoveryOwner.test.ts`, `sshCapabilityBridge.test.ts`) must be green untouched — if any goes red, the cut hit a shared path: stop and report rather than "fixing" the test.

---

### Task 4: Product guard test — no host-CLI surface in the phone app

**Files:**
- Create: `tests/unit/noHostCliSurface.test.ts`
- Modify: the gate registration if it enumerates files (check `scripts/run-js-unit-gate.sh`; if it runs the whole registered Vitest suite by config, no edit is needed — verify and note it)
- Test: the new file itself

**Interfaces:**
- Consumes: Tasks 1-3 (the patterns below must already be gone from `src/`).
- Produces: the standing acceptance contract for this spec; Task 8 re-runs it.

- [ ] **Step 1: Write the test**

```typescript
/**
 * The chat-only cut's standing guard (spec 2026-10-25): the phone app builds
 * no aplexer (`a …`) or host-CLI (`pocketshell …`) command and imports none
 * of core's terminal/usage host surfaces. Dev-mode mocks are included — the
 * mock must model the product, not the deleted surfaces.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|vue)$/.test(name) ? [path] : [];
  });
}

const COMMAND_PATTERNS: [RegExp, string][] = [
  [/pocketshell\s+(sessions|usage|repos|hooks|status|--version)/, 'host-CLI command'],
  [/(^|[^\w.@'`/-])a\s+(start|attach|kill|snapshot|list|watch)\b/, 'aplexer command'],
];

const IDENTIFIERS = [
  'hostCliSessions', 'usageSource', 'agentLaunch', 'buildAttachCommand',
  'aplexerAttachCommand', 'aplexerStartCommand', 'aplexerSnapshotCommand',
  'aplexerKillCommand', 'aplexerProbeCommand', 'subscribeTerminalOutput',
];

describe('no host-CLI surface in the phone app', () => {
  it('src/ builds no a/pocketshell commands and uses no host-CLI modules', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, label] of COMMAND_PATTERNS) {
        const match = text.match(pattern);
        if (match) offenders.push(`${file}: ${label} "${match[0].trim()}"`);
      }
      for (const identifier of IDENTIFIERS) {
        if (text.includes(identifier)) offenders.push(`${file}: identifier ${identifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

Note the `a ` pattern deliberately excludes `.`, `@`, `/`, backtick neighbors so `@pocketshell/core`, `aplexer-pi` and import paths cannot match; if it still produces a false positive during bring-up, tighten the character class — never widen the identifier list's exemptions.

- [ ] **Step 2: Run it**

```bash
pnpm vitest run tests/unit/noHostCliSurface.test.ts
```

Expected: PASS (Tasks 1-3 removed everything). If it fails, the hit list is leftover work — fix in the owning task's spirit, not by exempting files.

- [ ] **Step 3: Confirm gate registration and run the full gate**

Register the new test in `scripts/js-unit-test-manifest.json` (add `tests/unit/noHostCliSurface.test.ts` and its test title exactly as written — the gate fails unless every registered title ran). Then:

```bash
pnpm typecheck && scripts/run-js-unit-gate.sh
```

---

### Task 5: Trim the browser dev mock to the chat surface

**Files:**
- Modify: `src/dev/browser/mockHost.ts` (523 lines), `src/dev/browser/` peers that render the deleted surfaces, `docs/browser-dev-mode.md`
- Test: `pnpm dev:mock` boots and the connections/projects/会话 tabs work (manual, browser)

**Interfaces:**
- Consumes: Task 4's guard (the mock must not mention `pocketshell sessions` etc.).
- Produces: a mock that models the post-cut product.

- [ ] **Step 1: Delete the aplexer-shaped mock surfaces**

In `mockHost.ts`: remove `MockSession`, the five-session fixture and `sessionsListing()` (~lines 200-250), the `pocketshell sessions list` handler (~line 311), the usage NDJSON handler (~line 358) and the `tmux`/`tmuxctl` version strings (~lines 130-131). Keep: the fake host/key trust flow, the in-memory file tree + SFTP, the pi project/session tree, exec (`tail`, `cd`, …) that the chat reads ride, and the listening-ports mock. Sweep with the Task 4 grep before finishing.

- [ ] **Step 2: Adapt the mock's consumers**

```bash
grep -rln "MockSession\|sessionsListing" src/ tests/
```

Adapt each hit (`devBrowserCapacitor.test.ts` likely among them) to the trimmed mock; a case that existed to serve aplexer-session mock data is deleted. Remove deleted files/titles from `scripts/js-unit-test-manifest.json` in the same step.

- [ ] **Step 3: Update `docs/browser-dev-mode.md`**

Remove the "five sessions in three workspaces, two with mock agents" bullet and any sentence describing mock sessions/terminal/usage screens; state the mock covers connections, projects, conversations, files and ports.

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && scripts/run-js-unit-gate.sh
pnpm dev:mock   # then, in a browser at http://localhost:5173/: connect mock-devbox,
                # open 项目 and 会话, send nothing destructive; confirm no dead
                # session/terminal/usage entry remains. Kill the server after.
```

- [ ] **Step 5: Audit CI and lanes**

```bash
grep -rn "agents" .github/workflows/js-first-rewrite.yml scripts/connected-test.sh scripts/connected-js-smoke.sh 2>/dev/null | grep -iv "github\|user-agent" | head
```

Any lane or fixture reference whose only purpose was aplexer sessions (e.g. a Docker `agents` fixture install) is removed from THIS repo's scripts/workflow. The `tests/docker/` fixture files themselves may stay on disk if `release/0.5.x` references them — check with `git log --oneline -3 -- tests/docker/` and only delete what no branch needs; when unsure, leave the file and say so in the report.

---

### Task 6: Decisions and docs

**Files:**
- Modify: `docs/decisions.md`, `AGENTS.md`, `docs/architecture.md`, `docs/server-setup.md`, `docs/agent-awareness.md`, `docs/usage-panel.md`
- Test: none (docs-only task; `pnpm typecheck` as a no-op sanity check)

**Interfaces:**
- Consumes: the finished Tasks 1-5 state.
- Produces: the recorded decision text Task 7's reviewer and the commit message cite.

- [ ] **Step 1: Add D45 to `docs/decisions.md`**

Append after D44, same table shape:

```markdown
| D45 | The phone app is a chat-only client: the terminal surface and all aplexer/host-CLI consumption are removed from this repo (locked 2026-10-25, maintainer directive) | The maintainer: "同意，这两个都可以删；那就按照这个决定来做吧" (2026-10-25), after the aplexer/tmux/CLI dependency analysis in that conversation. The phone app builds no `a`/aplexer or `pocketshell` command (guard test `tests/unit/noHostCliSurface.test.ts`); its host contract is SSH + `pi`, with tmux recommended (without it a turn degrades to bare `exec pi` and dies on disconnect, per D44). `vendor/pocketshell-core` is unchanged and keeps the session/usage/hostCli surfaces for pocketshell-desktop and pocketshell-web. Supersedes D5 (terminal as the phone's secondary screen) for this repo; narrows D38's scope — aplexer remains THE session runtime for desktop/web via core and for `release/0.5.x`, but the phone app has no session runtime. The legacy shell (`App.vue`, `legacyMain.ts`) was already unreachable (only `src/main.ts` → `PhoneApp.vue` mounts) and is deleted in the same cut, including the provider-usage screen, which was unreachable with it. Cross-refs: **D22** (hard cut), **D42** (core still shared), **D44** (chat turn survival, the feature this cut centers). |
```

- [ ] **Step 2: Update `AGENTS.md`**

In the opening paragraph, replace "Voice-first, agent-aware Android SSH client with aplexer-backed sessions." with "Voice-first Pi chat client over SSH (D45): conversations ride pi session files; turns survive disconnects in a private tmux server (D44). The repo's Android app no longer ships a terminal screen or consumes aplexer/the host CLI — those remain core/desktop/web and 0.5.x surfaces." Keep the rest of the paragraph's branch description accurate (check every claim against the post-cut tree while editing).

- [ ] **Step 3: Update `docs/architecture.md` (0.6.0 section only)**

Remove the terminal screen from the module description; add after the ConnectionController paragraph: "The phone app is chat-only (D45): it keeps exec/SFTP/PTY/forwards over `SshCapability` and consumes no host-CLI surface (guard: `tests/unit/noHostCliSurface.test.ts`). Host contract: SSH + `pi`; tmux recommended (D44 degradation)." Do not touch the 0.5.x history section beyond noting at its top that main diverged at D45 if the maintainer's review asks for it.

- [ ] **Step 4: Reframe `docs/server-setup.md`**

Lead with the post-cut contract: an SSH account with key auth and `pi` on PATH; tmux recommended. Move the `pocketshell` CLI install and the non-interactive-PATH section under a clearly-labeled "Only for 0.5.x / desktop" heading, unchanged in content.

- [ ] **Step 5: Scope-note `docs/agent-awareness.md` and `docs/usage-panel.md`**

Add one line at each file's top: "Scope: desktop/web clients (shared core) and `release/0.5.x`. The phone app dropped these surfaces at D45." Prune nothing else (documentation-guide rule: prune only through that guide's process).

- [ ] **Step 6: Sanity**

```bash
pnpm typecheck && scripts/run-js-unit-gate.sh
```

---

### Task 7: Full verification, APK, and process hand-off

**Files:** none created; runs the checks and produces the APK.

**Interfaces:**
- Consumes: Tasks 1-6 all complete.
- Produces: the evidence bundle for the reviewer and the maintainer.

- [ ] **Step 1: Full local verification**

```bash
git status --short            # only expected deletions/modifications, core submodule untouched
git diff --stat -- vendor/    # must be empty
pnpm typecheck && scripts/run-js-unit-gate.sh
```

- [ ] **Step 2: Build the debug APK**

```powershell
git submodule update --init --recursive
pnpm install --frozen-lockfile
scripts/build-android-debug.ps1
```

Record the APK path, `versionName (versionCode)` from the build output, and its SHA-256 (`Get-FileHash -Algorithm SHA256 <apk>`).

- [ ] **Step 3: Report for review**

Report (task comment / issue comment): deleted-file totals, gate + typecheck output tails, APK path/version/sha256, and the kept/deleted hub member list from Task 3. Per process.md the orchestrator then dispatches a reviewer (emulator evidence per `docs/review-standards.md` — user-facing app-scope change), and only after APPROVED plus the maintainer's on-phone verdict does the orchestrator commit.

---

## Self-Review (done at plan time)

- **Spec coverage:** §4.1.1→Task 2, §4.1.2→Task 2, §4.1.3→Tasks 3-4, §4.1.4→Task 1, §4.1.5→Tasks 3/5, §4.2 keep-list→Global Constraints + Task 3 interfaces, §4.3→Task 6 docs + guard, §7→Task 6, §8→Tasks 3/4/5/7, §10→Task 7. No gap found.
- **Placeholders:** none; every deletion step names exact files or gives the exact grep + decision rule.
- **Type consistency:** the guard test's identifier list matches the member names deleted in Task 3 (`subscribeTerminalOutput`, `hostCommand`, …) and the core module names from the spec (§4.2).
