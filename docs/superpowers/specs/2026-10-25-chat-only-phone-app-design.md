# Chat-only phone app: delete the terminal surface, aplexer consumption and the host-CLI requirement

- **Date:** 2026-10-25
- **Status:** Draft for maintainer review
- **Origin:** Maintainer decision in conversation, 2026-10-25 ("同意，这两个都可以删；那就按照这个决定来做吧"), following the feasibility analysis in that conversation (aplexer vs tmux roles, aplexer lifecycle, CLI call-site inventory).

## 1. Context and motivation

The 0.6.0 phone app currently carries two server-side dependencies that exist
for its terminal surface:

- **aplexer** — the session runtime behind the terminal tab (`a start` /
  `a snapshot` / `a attach` / `a kill`, reached through core's
  `pocketshell sessions` host-CLI contract).
- **the `pocketshell` host CLI** — the only required host tool per
  `hostBootstrap`'s missing-tools list; it bundles aplexer and quse and
  carries the sessions/usage/repos/hooks command groups.

The 会话 (chat) tab depends on neither. By design (D44), a Pi chat turn runs
in a private tmux server (`tmux -L pocketshell-pi`) that is invisible to
aplexer's session list, and every chat read — project discovery, session
listing, conversation rendering, reply polling — is a plain SSH file read.
D44's carve-out ("an agent runner's own tmux is outside that decision") is
what makes this trim mechanically cheap.

The maintainer has decided to focus the phone app on the chat experience:
delete the terminal surface, stop consuming aplexer, and drop the host-CLI
requirement. After this change a host needs **SSH + `pi`** (plus tmux,
recommended — see §6.1).

## 2. Goals and non-goals

**Goals**

1. The phone app builds and runs no command of its own that invokes
   `a`/aplexer or any `pocketshell` subcommand. (Core-internal,
   informational probes that `ConnectionController` may still run on
   connect are not app-owned and stay — see §4.2.)
2. The terminal screen, its attach machinery, and every aplexer-session UI
   surface are deleted from this repo (hard cut per D22: no flag, no hidden
   path).
3. The unreachable legacy shell (`App.vue` + `legacyMain.ts` + screens only
   it mounts, including the provider-usage screen) is deleted, not parked.
4. Docs and decisions are updated to say what the product now is: a
   voice-first Pi chat client over SSH.
5. Connect, reconnect, grace, projects, conversations, composer, slash
   commands, ports/forwards and settings all keep working unchanged.

**Non-goals**

- No change to `vendor/pocketshell-core` (pinned submodule, shared with
  pocketshell-desktop and pocketshell-web — see §6.2).
- No change to the `pocketshell-cli` repo, the `aplexer` repo, or the
  `release/0.5.x` line, which keep the CLI and aplexer as their host story.
- No change to the pi turn runner, `piTurn.ts`, `pendingTurns`, or the chat
  stores beyond what deletion of neighbouring code forces.
- Port forwarding and the ports screen stay (they ride SSH, not the CLI).

## 3. Current state (verified 2026-10-25)

Live entry: `src/main.ts` mounts `src/phone/PhoneApp.vue` — the phone shell
(#2936). Within it:

- **Live terminal surface** — `PhoneApp.vue` mounts
  `src/components/terminal/TerminalScreen.vue` (attaches by aplexer session
  name), installs the terminal PTY seam (`src/session/terminalPty.ts`), and
  resolves session rows from core's controller snapshot for attach.
- **Live attach plumbing** — `src/platform/android/connectionHub.ts` owns
  attach requests, pending-attach buffering, per-session shell bindings and
  the aplexer screen-snapshot repaint path. Its `openPty` (used by the chat
  turn runner), exec, SFTP and forward channels are shared with chat and
  must survive.
- **Legacy, unreachable** — `src/App.vue` (the pre-phone shell) is imported
  only by `src/legacyMain.ts`, which nothing runs; a unit test references
  the file by name. It is the only mount of `ProviderUsageScreen.vue` and
  the legacy `SettingsScreen.vue` with its `navigation.open('usage')` entry.
  **Correction to the conversation's analysis:** the provider-usage screen
  is therefore already unreachable in the shipped app; deleting it is
  cleanup, not a feature cut.
- **Host-CLI call sites reachable from the live app:** the sessions group
  (terminal), `pocketshell --version` (agent launch, terminal-typed), and
  the bootstrap probe's required-tool verdict (informational; the
  missing-tools strip itself renders in the shared desktop/web view tree,
  not the phone shell). The usage and repos command builders in core have
  no live phone consumer.

## 4. Design

### 4.1 What gets deleted (this repo)

1. **Terminal UI** — `src/components/terminal/` (TerminalScreen and its
   subtree), `src/components/TerminalViewport.vue` and the terminal
   emulator/viewport helpers only it uses, `src/session/terminalPty.ts`,
   and every terminal entry point, tab target, or navigation route in the
   phone shell.
2. **Phone-shell wiring** — PhoneApp's `terminalPtyImplementation`, the
   `findSessionRow` attach lookup, `installTerminalPty` registration, and
   any aplexer-session switching UI in the live shell.
3. **connectionHub attach machinery** — `AttachRequest`, pending-attach
   buffering, per-session shell bindings, the attach snapshot/repaint path,
   and session-listing requests the hub made for attach. Kept: `openPty`
   (the turn runner's seam), bounded exec, SFTP, forwards, reconnect/grace,
   host-key trust. This is the most delicate part of the cut; the hub is
   the one connection owner and chat rides it.
4. **Legacy shell** — `src/App.vue`, `src/legacyMain.ts`,
   `src/components/SettingsScreen.vue`, `ProviderUsageScreen.vue`, and
   whatever else only this subtree imports (inventory step in the plan).
   `destinationInventory.ts` entries for the deleted routes are updated to
   `removed` with this change as the reason.
5. **Tests** — unit tests covering terminal attach, the hub's attach path
   and the legacy shell; connected lanes that only exercised aplexer
   sessions. The Docker aplexer (`agents`) fixture stays only if a
   remaining lane needs it — expected outcome: it does not, and this repo
   stops referencing it (the fixture itself lives on for the CLI repo and
   0.5.x).

### 4.2 What stays (the product after the cut)

- Connections tab: hosts, keys, host-key trust, connect, the reconnect
  ladder and background grace — all unchanged (core `ConnectionController`
  over the native `SshCapability`).
- 项目 projects tab and 会话 sessions tab: pi discovery, conversation list,
  chat view, composer, slash commands, turn runner, pending-turns sweep,
  local caches — unchanged.
- Settings (live `SettingsTab`), ports/forwards, fast keys, dictation,
  share/SAF — unchanged.
- Core imports: the phone app keeps importing core's connection,
  transport, sync, ui and pi-facing surfaces. It stops importing
  `hostCliSessions`, `usageSource`, `agentLaunch`, and terminal-specific
  helpers. Core may still run its connect-time bootstrap probe internally;
  the phone shell renders no missing-tools verdict off it, so it is inert
  traffic, not a requirement.

### 4.3 Host contract after the cut

A host needs: an SSH account reachable with a key, and `pi` on PATH (with
node reachable via the existing PATH prelude). tmux is **recommended**:
without it a turn degrades to bare `exec pi` and dies on disconnect (D44's
documented degradation). `pocketshell`, `a`/aplexer and `quse` are no
longer phone-app requirements; `server-setup.md` is rewritten accordingly.

## 5. Alternatives considered

- **A (chosen): hard-cut deletion in this repo only.** Smallest blast
  radius; desktop/web and 0.5.x are untouched; fully honors D22.
- **B: also strip the aplexer/hostCli surfaces from pocketshell-core and
  re-pin.** Rejected: core is shared with pocketshell-desktop and
  pocketshell-web, whose session panels are built on exactly those
  surfaces; deleting them there is a separate product decision in the core
  repo.
- **C: hide the terminal behind a build flag.** Rejected: D22 forbids
  flags for removed behaviour, and a hidden path is exactly what the
  hard-cut rule exists to prevent.

## 6. Called decisions (maintainer may veto in review)

1. **tmux stays capability-tested with documented degradation.** No new
   "required tools" UI is built in this change. Rationale: least change;
   the degradation is already shipped and documented under D44; promoting
   tmux to fail-loud is a small, independent follow-up if field use wants
   it. `server-setup.md` will state tmux as recommended.
2. **The core submodule is not modified.** The phone app simply stops
   importing the terminal/usage/hostCli surfaces. Core keeps them for
   desktop/web.
3. **The legacy shell is deleted in the same cut**, not left as dead code
   (D22's proactive-removal rule).
4. **No migration story is needed**: terminal sessions were never persisted
   as phone-local state that could dangle (rows were always re-listed from
   the host); the local caches that exist (projects/sessions/recents) are
   pi-file-based and unaffected.

## 7. Documentation updates (part of this change)

- `docs/decisions.md`: new decision (next free number, D45) — *the phone
  app is a chat-only client; the terminal surface and all aplexer/host-CLI
  consumption are removed* — recording the maintainer's 2026-10-25
  directive, superseding D5 (terminal as the phone's secondary screen) and
  narrowing D38's scope (aplexer remains the session runtime for
  desktop/web via core and for 0.5.x; the phone app no longer has a
  session runtime). Cross-refs D44, D42.
- `AGENTS.md`: first paragraph and branch description drop
  "aplexer-backed sessions" as the phone product shape.
- `docs/architecture.md` (0.6.0 section): module map loses the terminal
  screen; a short "host contract" paragraph states SSH + pi (+ recommended
  tmux).
- `docs/server-setup.md`: the non-interactive-SSH PATH section is reframed
  — installing the `pocketshell` CLI is no longer required for the phone
  app; keep a pointer for 0.5.x/desktop users.
- `docs/agent-awareness.md`, `docs/usage-panel.md`: marked as describing
  desktop/web (core) surfaces, or pruned per `documentation-guide.md`.

## 8. Testing impact

- Unit gate (`scripts/run-js-unit-gate.sh`): terminal/attach/legacy tests
  deleted; chat, connection, sync, stores suites unchanged and must stay
  green.
- New/adjusted tests: the hub keeps `openPty`/exec/SFTP behaviour under
  reconnect (existing reconnect tests carry this); a guard test asserting
  no `pocketshell `/`a ` command string is built anywhere under `src/`
  (the same grep-style product guard pattern the repo already uses).
- Connected lanes: `smoke` and `composer-docker` keep the SSH fixture; any
  lane whose only purpose was aplexer sessions is dropped. Reviewer
  emulator evidence per `docs/review-standards.md` is required — this is
  user-facing terminal/app-scope work.

## 9. Risks

- **connectionHub surgery** (highest): the attach removal must not disturb
  the reconnect/grace path chat rides. Mitigated by the existing
  reconnect/grace journeys staying in the gate.
- **Product narrowing is irreversible-in-spirit**: the maintainer loses
  phone-side terminal access to their dev box. Explicitly accepted in the
  origin conversation; recoverable only by reverting.
- **Hidden consumers** of "terminal-adjacent" code (viewport fonts, theme
  tokens) discovered mid-cut: handled by the plan's inventory step; nothing
  in the chat path referenced terminal components (verified by grep at spec
  time).

## 10. Process

Per `process.md`: the orchestrator files one GitHub issue from this spec;
an implementer executes (code + tests, no commits); a reviewer posts
APPROVED/CHANGES REQUESTED with emulator evidence; the orchestrator builds
the debug APK (`scripts/build-android-debug.ps1` on this Windows box),
hands the maintainer the path/version/sha256, and waits for the on-phone
verdict before anything merges. Docs-only edits may ride the same change.
