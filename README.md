# pi-pocket — a WeChat-style phone shell forked from PocketShell

> **This is a fork.** It is derived from
> [PocketShell-io/pocketshell](https://github.com/PocketShell-io/pocketshell),
> which remains upstream. This repository —
> <https://github.com/ZKai0801/pi-pocket> — keeps upstream's SSH, credential and
> terminal machinery and rebuilds the phone surface as a single WeChat-style
> shell driven by the `pi` coding agent.

## What upstream PocketShell is

PocketShell is a voice-first Android SSH client with aplexer-backed sessions,
built on a shared `pocketshell-core` that also serves web and desktop. Its
`main` branch is the 0.6.0 line — a Vue 3 / TypeScript / Capacitor app; the
released 0.5.x Kotlin app lives on `release/0.5.x`.

## What this fork changes

The rebuild brief is [docs/todo.md](docs/todo.md) (Chinese); the UI spec is
[docs/superpowers/specs/2026-10-19-wechat-ui-pi-design.md](docs/superpowers/specs/2026-10-19-wechat-ui-pi-design.md).

### 1. One phone shell with a bottom tab bar — replacing one dense terminal-first screen

Upstream's phone UI is a single long `App.vue`: a connect form, a terminal, and
twenty settings screens. Using it on a phone for agent work means too many
screens, small targets, and no readable conversation surface.

This fork mounts a single shell — [`src/phone/PhoneApp.vue`](src/phone/PhoneApp.vue)
— with a bottom tab bar: **Connect / Project / Session / Setting** (Connections / Projects /
Sessions / Settings; the brief asked for three tabs, Settings was added as a
fourth). See [`src/components/shell/AppTabBar.vue`](src/components/shell/AppTabBar.vue).

### 2. project tab — projects discovered from the server, not configured by hand

After connecting, the tab lists the project paths `pi` already stores on that
host, rather than asking the user to type them. Search filters the list; new
projects can be added. Implementation: `src/pi/sessionRoot.ts`,
`src/pi/piRepository.ts`, [`src/stores/projects.ts`](src/stores/projects.ts),
[`src/components/projects/ProjectsList.vue`](src/components/projects/ProjectsList.vue).

### 3. session tab — agent conversations as a WeChat chat

Tapping a session opens a WeChat-style bubble view and the composer continues
that conversation — it is a chat surface, not a terminal. Only the conversation
body is rendered: a user turn and the assistant's text reply. **Tool calls, tool
results, bash output and sub-agent traffic are not rendered.** Implementation:
[`src/components/sessions/ChatScreen.vue`](src/components/sessions/ChatScreen.vue),
`ChatBubble.vue`, `ChatComposer.vue`, `src/pi/parsePiSession.ts`,
`src/chat/markdown.ts`.

### 4. `pi` is the only agent; aplexer is no longer the app's agent surface

Upstream derives agent identity and conversation state from **aplexer**, the
session runtime shipped inside the `pocketshell` CLI.

This fork talks to the remote **`pi`** (`pi-coding-agent`) CLI directly instead:
it resolves the `pi` executable per host, parses `pi`'s session JSONL into chat
turns, and sends a turn over its own PTY. See [`src/pi/`](src/pi/) and
`src/session/piLive.ts`. The terminal survives as a **secondary** screen and
still attaches to an aplexer session PTY.

### 5. Credentials can be remembered once, sealed by the Android Keystore

A key passphrase or password typed on first use is stored so later connects do
not re-prompt — the point the brief called out explicitly. The store is a
Keystore-sealed native surface: `src/native/rememberedSecrets.ts`, with
`RememberedSecretStoreTest` covered by the JVM unit gate.

### 6. CI and gates are trimmed for an Android-only, Windows-developed fork

[docs/fork-gate-posture.md](docs/fork-gate-posture.md) is the authoritative
record; read it before adding a workflow step or a `scripts/check-*` guard.
Headlines:

- The packaged emulator journey lanes, Docker lanes, the 24-journey
  release-validation chain and `publish-release` do not apply to this fork and
  are gated off (`if: false`).
- 46 of the 58 referenced guard scripts are retired or dormant; 12 are kept.
- Windows-native entry points were added, because this fork is developed on
  Windows: `scripts/build-android-debug.ps1`, `scripts/run-js-unit-gate.ps1`,
  `scripts/android-doctor.ps1`, `scripts/start-emulator.ps1`.

The rule the posture doc sets is: **do not weaken a gate to make it pass.** A
guard that no longer applies is retired with a recorded reason; a guard that
applies and fails is a defect to fix.

## What this fork keeps from upstream

SSH transport, host-key trust, the encrypted key vault, the PTY/terminal,
keyboard insets, durable storage, and the pinned `vendor/pocketshell-core`
submodule (which still carries the shared UI package). Identity is unchanged:
`applicationId com.pocketshell.app`, minimum SDK 26, target SDK 35, compile SDK
36, and the existing debug key. Room schema exports retained for the future
installed-data reader live under
[docs/migration/room-schemas/](docs/migration/room-schemas/).

## Current state — what is and is not proven

Stated plainly, because much of the tree is inherited from upstream and not all
of it has been exercised here:

- **Packaged-APK acceptance, 2026-10-21 rerun** ([docs/acceptance/2026-10-21-wechat-ui-rerun.md](docs/acceptance/2026-10-21-wechat-ui-rerun.md)):
  the tab bar **passes**, and a key host and a password host now save and seal.
  Connecting, the projects list, sessions, chat, the terminal and reconnect
  behaviour are **not accepted** — the test box has no SSH server (client only,
  no `sshd`), so nothing can be dialled. That is a missing fixture, not a
  product defect.
- **The 0.5.x → 0.6.0 upgrade path is not proven and is unresolved.**
- **JS unit gate on this Windows box:** 109 files / 835 tests, 834 pass, and 1
  documented red — `tests/unit/sshKeySetup.test.ts:401` asserts a key file is
  mode `0o600`, while Windows reports `0o666`. It is documented, not fixed: the
  assertion must keep holding on CI Linux, which stays authoritative.

## Build and test

Requirements: Node.js 22, pnpm 12.5.1, JDK 21, and Android SDK platform 36.

```sh
git clone --recurse-submodules https://github.com/ZKai0801/pi-pocket.git
cd pi-pocket
pnpm install --frozen-lockfile
scripts/run-js-unit-gate.sh        # or scripts/run-js-unit-gate.ps1 on Windows
scripts/assemble-debug.sh          # or scripts/build-android-debug.ps1 on Windows
```

`vendor/pocketshell-core` is the only Git submodule and is still pinned to
upstream core. Android imports core TypeScript (`@pocketshell/core`) and core's
browser-safe `packages/ui/` source (`@ui`) directly; it is not an npm package.
JS tooling dependencies are locked in `pnpm-lock.yaml`. To build and install
under an isolated package name:

```sh
scripts/assemble-debug.sh --suffix local --install
```

### Run it in a browser (no Android)

```sh
pnpm dev:mock   # fake host with sessions, a scripted terminal, files, usage and ports
pnpm dev:live -- --host testuser@127.0.0.1:2222=fixture --identity tests/docker/test_key
```

Open <http://localhost:5173/>, then switch Chrome DevTools to a phone viewport
(Ctrl+Shift+M, e.g. "Pixel 7"). Details, security notes and the simulated
plugins: [docs/browser-dev-mode.md](docs/browser-dev-mode.md). None of this
ships in the APK.

The preserved Docker agents fixture can be checked with:

```sh
scripts/test-agents-fixture-aplexer.sh --docker
```

The local acceptance emulator is driven by `scripts/start-emulator.ps1`, not by
CI.

## License

Inherits upstream's proprietary notice; see [LICENSE](LICENSE). Upstream
project: <https://github.com/PocketShell-io/pocketshell>.
