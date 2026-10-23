# PocketShell — WeChat-style phone UI rebuild, Pi-agent chat

Date: 2026-10-19
Status: draft for approval (brainstorming output; not yet planned or built)

## 1. Intent and why

PocketShell 0.6.0's phone UI is a dense, terminal-first tool: one long
`App.vue` with a connect form, a terminal, and twenty settings screens. Using
it on a phone for agent work is awkward — too many screens, small targets, no
readable conversation surface.

This project keeps the parts that already work (SSH transport, host-key
trust, the encrypted key vault, the PTY/terminal, keyboard insets, durable
storage) and rebuilds the surface as a phone app that feels like WeChat:
three bottom tabs, large touch rows, and a chat view for reading and
continuing an agent conversation.

Agent support is **Pi only** (`pi-coding-agent`) for now. The chat shows only
the conversation body — a user turn and the assistant's text reply. Tool
calls, tool results, bash output and sub-agent traffic are not rendered.

## 2. Goals

- **G1** Bottom tab bar, three tabs: **连接 / Connections**, **项目 / Projects**, **会话 / Sessions**.
- **G2** Connections tab: list saved servers; add/edit; auth by password or key; on first entry of a key passphrase, offer to remember it so later connects do not re-prompt.
- **G3** Projects tab: after connecting, auto-discover the project paths stored on the server (from Pi's session storage) and list them.
- **G4** Sessions tab: list one project's Pi conversations; tap one to open a WeChat-style chat; send a message that continues that conversation; pull to refresh.
- **G5** Reuse the existing SSH/credential/terminal machinery instead of rewriting it.
- **G6** Pi-only agent parsing.

## 3. Non-goals (v1)

- Account / cloud sync, provider usage/quota, port-forwarding UI, file
  workspace/editor, host snippets, diagnostics UI, voice/dictation, fast keys.
- Live token-by-token streaming. Refresh is explicit (pull-to-refresh / on open).
- Agents other than Pi (Claude Code, Codex, OpenCode, Grok Build).
- Desktop and web clients.
- Editing, forking, deleting, or renaming Pi sessions from the phone.

## 4. Anti-goals

- Do not fork or re-implement core logic (`ConnectionController`,
  `SshCapability`, `HostCliCore`, path/trust helpers). Import it.
- Do not add colour / radius / shadow / motion values outside the token
  system; the `designTokens.test.ts` guard fails on raw literals.
- Do not surface tool calls or sub-agent output in the chat.
- Do not keep two competing shells (legacy + shared) in the new app.

## 5. Constraints and environment (must be fixed before building)

The checkout at `D:\projects\pocketshell` currently cannot build:

- **Not a git repository** (`.git` absent).
- **`vendor/pocketshell-core` is empty** — the pinned submodule
  (`https://github.com/PocketShell-io/pocketshell-core.git`) is not checked
  out, and the `@pocketshell/core` / `@ui` aliases
  (`vite.config.ts:236-246`, `tsconfig.json:17-24`) resolve into it.
- **`node_modules` absent**; **`pnpm` not installed** (Node v25 present).

Consequences and calls:

- Restore core first. The recorded pin cannot be recovered from this checkout
  (no git metadata), so core is checked out at a branch tip and its SHA
  recorded in the new repo's history. **Risk:** a newer core than the app was
  written against may have moved `ConnectionController` / `HostCliCore`
  signatures. First task is to pin and typecheck.
- Platform is Windows. Build with `android/gradlew.bat`; `scripts/*.sh` are
  POSIX shell and the Docker/emulator lanes in `docs/testing.md` target Linux.
  Android SDK + JDK are assumed present or installed as part of setup.
- **Target server:** `192.168.1.3`, Ubuntu, Samba host `kai-server`, SSH alias
  `kai-server-local`, user `kai`, home `/home/kai`. Pi config dir
  `/home/projects/.pi-agent` → session root `/home/projects/.pi-agent/sessions`
  (**not** under `$HOME`). `pi` binary:
  `/home/projects/softwares/node-v25.2.1-linux-x64/bin/pi` (not on the
  non-interactive SSH PATH). Host CLI `pocketshell 0.5.4` at
  `/usr/local/bin/pocketshell`. SMB is used today to capture fixtures; the app
  reaches the server over SSH.
- **Local Android toolchain is absent:** only `adb` exists
  (`D:\software\SDK_r35.0.0-windows\platform-tools`). No JDK, no SDK
  platforms/build-tools, no emulator, no system image, no `pnpm`. A setup
  phase must install these before any packaged-APK acceptance.

## 6. Architecture

### 6.1 Shell and entry

Keep the boot sequence (`src/main.ts`) but collapse the two shells into one.
The shared-shell path (`src/sharedApp/*`, mounting core's `AppRoot.vue`) is
removed; the new UI is the single shell. The new root replaces the screens of
`src/App.vue` while keeping its connection/terminal mechanics.

The new UI drives the reused stack the same way legacy `App.vue` does today:

- `src/session/connectionController.ts` (`ConnectionController extends
  PortableConnectionController`) for dial / host-key / sessions / attach /
  reconnect / grace.
- `src/native/sshCapability.ts` (`sshCapability`) for raw `exec`, `openPty`,
  `writePty`, `readPty`, `closePty`, and `sftpRead`.
- `src/components/TerminalViewport.vue` for the retained terminal screen.

The shared-app transport (`src/platform/android/androidApi.ts`,
`connectionHub.ts`) is **not** used and is removed.

### 6.2 Keep (the reused front half)

| Concern | File(s) |
|---|---|
| Boot, durable storage, bridge warm-up | `src/main.ts`, `src/native/bridgeReady.ts`, `src/native/durableStorage.ts` |
| SSH plugin (sshj) | `android/.../SshCapabilityPlugin.java`, `src/native/sshCapability.ts` |
| Connection/session/reconnect owner | `src/session/connectionController.ts` |
| App lifecycle / background grace | `src/session/appLifecycle.ts` |
| Host-key trust | `src/session/hostKeyCard.ts`, `src/platform/android/trustStore.ts` |
| Key vault | `src/native/sshKeyVault.ts`, `android/.../CredentialHandleVault.java`, `EphemeralCredentials.java` |
| Host list store | `src/platform/android/hostStore.ts` |
| Terminal | `src/components/TerminalViewport.vue` (+ xterm deps) |
| Keyboard insets | `src/native/keyboardInsets.ts`, `KeyboardInsetsPlugin.java` |
| Core (submodule) | `ConnectionController`, `HostCliCore`/`hostCliSessions`, `sessionRowSummary`, `hostKeyTrustCore`, `remotePathPolicy`, `projectCommands` |

### 6.3 Remove (candidates; the plan freezes the exact list)

- Whole shared-shell: `src/sharedApp/*`, `src/platform/android/androidApi.ts`,
  `src/platform/android/connectionHub.ts`.
- Legacy screens: `AboutScreen`, `AccountSyncScreen`, `DiagnosticsScreen`,
  `PortForwardScreen`, `ProviderUsageScreen`, `FileWorkspaceScreen`,
  `HostSnippetsScreen`, `EmptyStateSignIn`, `BuildIntegrityAlert`,
  `SessionAgentMetadata`, `TerminalDictationBar`, `ComposerRecordingMode`,
  `DictationMicIcon`, `MobileHotkeys`.
- Features: `src/vault/*`, `src/sync/*`, `src/platform/android/{sync,googleSync,gatewayPairing}.ts`,
  `src/native/{documentContent,googleSync,gatewayPairing,speechRecognition,vaultNative}.ts`,
  `src/session/{dictation*,inlineDictation,documentTransfers,files}.ts`,
  `src/stores/hostSnippets.ts`, `src/diagnostics.ts` UI.
- `SettingsScreen.vue` shrinks to what the new app needs (theme, maybe font).

**0.5.x installed-data migration (my call).** This fork is a fresh checkout
with no prior on-device data, so `src/migration/installedDataMigration.ts` and
its import UI are dropped; the new Connections tab starts from the v2 host
store (§7.1) with a localStorage v1→v2 migration only. If this app is ever
installed over an existing 0.5.x/0.6.0 install, the import path must come
back — flagged as a risk, not built in v1.

### 6.4 New

- `src/pi/` — Pi over SSH: discovery, session listing, JSONL parsing, turn runner.
- `src/stores/connections.ts` — saved hosts + connection state.
- `src/stores/projects.ts` — discovered projects per host.
- `src/stores/sessions.ts` — Pi conversations per project.
- `src/components/shell/AppTabBar.vue` — the bottom three-tab bar.
- `src/components/connections/{ConnectionsList,ConnectionEditor}.vue`.
- `src/components/projects/ProjectsList.vue`.
- `src/components/sessions/{SessionList,ChatScreen,ChatComposer}.vue`.
- `src/components/terminal/TerminalScreen.vue` — retained terminal (see §8.7).

## 7. Data model

### 7.1 Saved host (extended)

Today `SavedHost` (`hostStore.ts:19-26`) is `{name, hostname, port, user,
keyHandleId}` — key-only, no password, no passphrase. Extend to:

```
SavedHost {
  name, hostname, port, user,
  auth:
    | { kind: 'key', keyHandleId: string, rememberPassphrase: boolean }
    | { kind: 'password', passwordCredentialId: string }
}
```

Stored in `localStorage` under a new key (v2) with a migration from
`pocketshell.android.hosts.v1`. Secret material (key bytes, key passphrase,
password) never lives in `localStorage`; only handles/ids do.

### 7.2 Credential vault changes (native)

No passphrase is persisted today: `SshKeyMetadata` carries only
`passphraseRequired: boolean`, and the passphrase is re-entered every connect
(`App.vue:192,796,805`). Two native additions are required:

- **Remember key passphrase.** When "remember" is on and the user first enters
  a passphrase, store it encrypted (AES/GCM + Android Keystore, as the key
  vault already does) keyed by `handleId`. The dial path then supplies
  `{kind:'key-handle', handleId, passphrase}` without prompting. A "forget"
  action clears it. On vault key delete, the passphrase record is deleted too.
- **Password auth.** Add a password credential store (same Keystore sealing),
  addressed by an opaque id, so `{kind:'password', password}` can be built at
  dial time without the password entering JS beyond the editor.

This is native (Java) work plus a small plugin surface; it is the largest new
native change in the project.

### 7.3 Project

```
Project { id: string /* encoded dir */, path: string /* absolute cwd */, name: string /* basename */ }
```

Identity is the absolute `cwd` from Pi's session header, not the encoded
directory name (see §9.1).

### 7.4 Pi session and message

```
PiSession { path: string, id: string, name: string | null, updatedAtMs: number,
            preview: string | null, messageCount: number }
PiTurn { role: 'user' | 'assistant', text: string, timestampMs: number }
```

## 8. Screens

Visual direction is the maintainer's sketch (`docs/UI-design.png`): WeChat
layout — grey page, white rows, green accents, bottom tab bar, green
self-bubbles and white other-bubbles in the chat. See §10 for tokens.

### 8.1 Shell + tab bar

`AppTabBar.vue` fixed at the bottom, three items (连接 / 项目 / 会话) with
icon + label, active item tinted. Tabs are peer roots; each keeps its own
nav stack. Android Back pops the current tab's stack, then (at root) keeps the
existing "Back does nothing on home / doesn't kill the app" behaviour from
`src/session/homeSurface.ts` (kept for that purpose). Icons come from core's
`AppIcon` where a suitable glyph exists; otherwise a local SVG that is moved
into core before shipping (design-system rule).

### 8.2 Connections (tab 1)

List of saved hosts: green/red dot for connected/idle, name, `host · user`,
a key glyph when key-authed, `…` for edit/delete. `+` in the app bar opens the
editor. Empty state: a big "新增连接" button.

Connection status is per host and driven by `ConnectionController` snapshots.
Only one live connection at a time in v1 (the controller is single-connection);
switching hosts closes the current one after a confirm.

### 8.3 Add / edit connection

Fields: name, host/IP, port, user, auth method (password | key).

- Key: pick from the vault (import/generate lives here or reuses the existing
  `SshKeysScreen` reduced to an import sheet); a **remember passphrase** toggle;
  a passphrase field shown on first entry when the key is passphrase-protected.
- Password: a masked field.

On save + connect: dial via the controller; on unknown host key, show the
existing host-key prompt (`HostKeyTrustPrompt.vue` from core, driven by
`hostKeyCard.ts`).

### 8.4 Projects (tab 2)

If not connected, prompt to connect on tab 1. When connected, run discovery
(§9.1) and list projects: folder glyph, name, path in mono, `…` (later:
rename/hide locally). Search box filters. Pull to refresh re-runs discovery.

### 8.5 Sessions (tab 3)

Requires a selected project. List that project's Pi conversations newest
first: first user text as title (or Pi `name`), last assistant text as preview
(one/two lines, truncated), relative time. `+` starts a new conversation
(creates a Pi session via a first message; see §9.4). Empty state names the
project.

### 8.6 Chat

WeChat chat: scrolling list of bubbles (user right/green, assistant
left/white), timestamps as subtle separators, assistant text rendered as
markdown (`marked`, already a dependency) with fenced code blocks as mono
blocks. A single composer bar at the bottom (text field + send) stays above
the IME using the existing inset wiring. Opening the screen reads the session
(§9.3); pull-to-refresh re-reads. Sending appends optimistically, runs the
turn (§9.4), then refreshes.

**Markdown is untrusted (my call).** Assistant text and even the user's own
echoed text are remote content rendered inside a WebView. `marked` does not
sanitize. The chat renders markdown to a sanitized subset: disable raw HTML
in `marked`'s output and sanitize the result (add a small allow-list
sanitizer such as DOMPurify) before it reaches the DOM; links render as text
or are opened explicitly, never auto-followed. Fenced code is escaped, not
interpreted.

### 8.7 Terminal (retained, secondary)

The reused terminal is reachable from a session's header as **打开终端**
(the 项目 page carried a copy of the action and no longer does: the
session header is the one that knows which project the conversation
belongs to, while the project list only knew a folder path):
attach to an aplexer session for that workspace (existing
`sessions attach` + `TerminalViewport`), giving a real escape hatch for
anything the chat surface does not cover. This is the concrete home for the
"tmux terminal" half being reused, and it keeps the aplexer/host-CLI runtime
in the product. It is out of the three-tab flow (opened from a header action
or overflow), not a tab itself.

## 9. Pi integration (`src/pi/`)

**Format verified.** The layout below is confirmed against a real session
from the target server (`\\192.168.1.3\projects\.pi-agent\sessions\--home-kai--\2026-10-18T01-52-19-726Z_01a14cb5-b70d-76f4-b739-6721b8b88c02.jsonl`,
52 entries). Pi here is a rebranded build whose config dir is **`.pi-agent`**,
not the stock `~/.pi/agent`, so the session root is **discovered, not
hardcoded** (§9.1). Verified entry types: `session`, `message`, `model_change`,
`thinking_level_change`, `session_info`, `custom`. Message roles: `user`,
`assistant`, `toolResult`. The test server has 790 session files across 38
project dirs.

### 9.1 Discovering projects

**Session root is discovered, not assumed.** The target Pi is a rebranded
build with config dir `.pi-agent` at `/home/projects/.pi-agent` (sessions at
`/home/projects/.pi-agent/sessions`) — neither the stock
`~/.pi/agent/sessions` nor under `$HOME`. Resolver: a per-host override saved
in the app wins; otherwise probe `$PI_CODING_AGENT_SESSION_DIR`,
`$HOME/.pi-agent/sessions`, `$HOME/.pi/agent/sessions`, first that exists.
**In practice the per-host override is required on this server**, so the
Connections editor exposes a "Pi sessions directory" field (blank = probe),
defaulted from the host's last successful connect.

Pi groups sessions under `--<encoded-cwd>--/` folder names. The encoding is
lossy (Pi replaces `/`, `\`, `:` with `-`), so it is **not** decoded back.
Instead:

1. `exec` `ls -1 <root>` (dirs named `--…--`).
2. For each dir, read a header line of any `.jsonl` inside:
   `head -n 1 "<dir>"/*.jsonl` → `{"type":"session",…,"cwd":"/abs/path"}`.
3. Project = `{ path: cwd, name: basename(cwd) }`, de-duplicated by `path`.

Read-only and cheap; bound output and skip a dir with no readable header.

**Adding a project (maintainer's request).** A project is just a directory
that can hold Pi sessions, so **新增项目** opens a server directory browser
(native `sftpList`, rooted at `$HOME`); a chosen directory becomes a project
immediately and is listed even before it has a session. Starting a
conversation there creates the first Pi session in it (§9.4).

### 9.2 Listing a project's sessions

`ls -1t "<root>/--<encoded>--"/*.jsonl` (newest first). For each file derive:
id (filename `<timestamp>_<uuid>.jsonl`), name (last `session_info` entry's
`name`, else the first user text), `updatedAtMs` (mtime), preview (last
assistant text) and message count. The list reads only what it needs (header +
tail), not whole files; opening a chat reads the whole file (§9.3).

### 9.3 Parsing a session file (`parsePiSession.ts`)

Input is the JSONL text; each line is an object with `type`. Verified against
one real session:

- `session` — header (`version`, `id`, `timestamp`, `cwd`); not a message.
- `message` — `{id, parentId, timestamp, message:{role, content, …}}`:
  - `user`: `content` is an **array of blocks**; take `type === 'text'`.
  - `assistant`: `content` is an array of `thinking` / `toolCall` / `text`
    blocks; take `type === 'text'` only. (In the sample, 18 assistant
    messages held 18 `thinking` + 21 `toolCall` + **1** `text` block — the
    final answer.)
  - `toolResult` and any other role: dropped.
- `session_info` — `{name}`; used for the session title (§9.2).
- `model_change`, `thinking_level_change`, `custom` (extension records such as
  subagent results), and anything unrecognized: dropped.

**Turn grouping.** Group into turns: one `user` turn, then all assistant text
until the next `user` turn, concatenated into one assistant bubble. Order is
file (append) order. Output `PiTurn[]` (`{role, text, timestampMs}`). Pure
function, unit tested against the captured fixture plus edge fixtures (empty
text, thinking-only turn, missing header).

**Reading strategy.** Files can exceed the exec caps. Prefer
`sshCapability.sftpRead` (512 KiB per transfer, native `SFTP_OUTSIDE_ROOT`
guards against escaping the home root) with an `exec` (`cat`/`tail -c`) fallback
for the preview path, and `tail` for list previews rather than reading whole
files. The plan picks exact bounds.

### 9.4 Sending a message (continuing the conversation)

The controller today attaches a PTY to an aplexer session and the app writes
bytes to it. Pi can instead be driven directly for a turn. v1 mechanism:

1. Open a PTY with the reused transport (`sshCapability.openPty`) in the
   project `cwd` and run `pi --session <path>`. The `pi` command / PATH are
   per-host configurable — on the target server `pi` is at
   `/home/projects/softwares/node-v25.2.1-linux-x64/bin/pi`, off the
   non-interactive PATH, so the run prefixes a PATH export.
2. Write the user message as a line (reuse `composerDelivery.ts` framing).
3. Poll/re-read the session `.jsonl` until the assistant text turn appears;
   refresh the chat.
4. Keep the PTY for the next message in the same open chat; close it on leave.

Why PTY and not a one-shot `pi -p "<msg>"` over `exec`: an agent turn can run
for minutes, and the Android exec path caps at 30 s (`connectionHub.ts`
default) / 120 s native. The PTY has no such per-turn deadline and is the
machinery already being reused. `pi -p` is noted as a possible simpler path if
turns turn out short, decided in the plan.

**PTY ownership and lifecycle (my call, revised 2026-10-23 — see D44 in
`docs/decisions.md`).** The turn PTY is owned by a `PiTurnRunner` in the phone
layer, not by `ConnectionController` (the controller's session model is
attached aplexer terminals, not ad-hoc Pi turns). It uses **one** channel of
the 8-per-connection budget while a turn runs. Rules:

- The session `.jsonl` on disk is the single source of truth; the chat is a
  reader. No conversation state lives in the runner.
- **Pi does not run in that PTY.** The PTY attaches to a tmux session on a
  private server (`tmux -L pocketshell-pi`) named after the conversation, and
  Pi is started inside it. The SSH PTY is a viewer/input client, so a dropped
  connection detaches a client and never signals the agent.
- Switching host tears the runner down (its PTY belongs to the old
  connection); the turn keeps running on the old host's tmux server, and the
  `.jsonl` still holds whatever Pi writes.
- On reconnect the runner is **rebound, not disposed**: the dead handle is
  dropped and the run is kept, so the chat still says "running" and the next
  line re-attaches to the same session instead of being refused.
- The session is killed only once a turn has actually been answered — never on
  a deadline or a disconnect, where Pi may still be working.
- The runner is the only watcher that kills that session, and it does not
  outlive the app: every delivered turn is written down (host, session name,
  file, the assistant-turn count that means "answered"), and each connection
  rechecks its host's records. A run that finished while the phone was away is
  closed then; a run whose count has not been reached is left alone, and a
  record whose file cannot be read survives for the next connection.
- One turn at a time per open chat; the composer is disabled while a turn runs.

**Known risks to resolve in the plan:** concurrency with an already-running
interactive `pi` for the same session (two writers to one file); how a "new
conversation" is started (first `pi --session-id <new>` / `pi` with no session
then adopt the created file); non-streaming means refresh is the only way to
see progress.

## 10. Visual system

The shared design system (`docs/design-system.md`: tokens, `AppIcon`,
primitives in core `packages/ui`) stays the source of truth. The WeChat look
is added as a **phone-layer** concern, not a core fork:

- Add a small phone token block in `src/styles.css` for the WeChat roles the
  phone needs and core does not have, e.g. `--chat-bg`, `--bubble-self-bg`,
  `--bubble-self-fg`, `--bubble-other-bg` `--bubble-other-fg`, `--tabbar-active`.
  `designTokens.test.ts` allows tokens declared in the phone stylesheet.
- Green accent: use the existing `--accent` family where it fits; the WeChat
  green for the tab bar / send button is a phone token if `--accent` cannot be
  used without restyling shared controls.
- Components read only tokens (`--sp-*`, `--r-*`, `--fs-*`, `--font-mono`),
  never raw values. Code blocks and paths use `--font-mono`.
- Tap targets ≥ 48 px (existing phone rule). Bubbles wrap long text; the chat
  list is virtualized only if profiling shows a need (v1 renders the loaded
  page).

## 11. Reused contracts (reference)

- Session runtime: `pocketshell sessions list|create|attach|kill` (schema 3),
  via core `HostCliCore`/`hostCliSessions`; attach = `a attach` (D38/D42).
- SSH: native plugin `SshCapability`, 8 channels/connection, exec 1 MiB/120 s,
  SFTP 512 KiB, PTY cols/rows 1–1000.
- Trust: `HostKeyTrustStore` + `pocketshell.ssh.host-key.<hostId>`.
- Boot: durable storage hydrate + shell selection in `src/main.ts`.

## 12. Decisions (mine) and open questions (needed from the maintainer)

**My calls — check these while reading:**

- D1 One shell; shared-shell path removed (§6.1, §6.3).
- D2 Auth stored as handles/ids in `localStorage`; secrets only in the native
  Keystore-sealed vault (§7.1, §7.2).
- D3 Projects are keyed by absolute `cwd` from the session header, not by the
  encoded dir name (§9.1).
- D4 Chat drop-list: tool calls/results, thinking, bash, system, compaction
  (§9.3).
- D5 Terminal is a secondary screen reached from a project/session, not a tab
  (§8.7).
- D6 Non-streaming; pull-to-refresh (§3, §9.4).
- D7 WeChat colours are phone-layer tokens, not a core theme (§10).
- D8 Single live connection at a time in v1 (§8.2).
- D9 Chat markdown is sanitized; raw HTML disabled (§8.6).
- D10 The Pi turn PTY is phone-owned by `PiTurnRunner` and Pi runs in a
  server-side tmux session behind it, so a reconnect/background/host-switch
  detaches a client instead of killing the turn; the `.jsonl` is the source of
  truth (§9.4). **Revised 2026-10-23** — the original "abandoned, not resumed"
  rule killed in-flight work on every reconnect; see D44 in
  `docs/decisions.md`.
- D11 0.5.x installed-data migration dropped for this fork (§6.3).
- D12 **Pi parsing lives phone-side** (`src/pi/`) rather than in the shared
  host CLI / core, as a deliberate fork deviation from D42's "shared logic in
  core". Rationale: this fork owns no cross-repo work and the parsing is
  read-only over the existing `exec`/`SFTP` transport. If the maintainer wants
  D42 purity instead, this becomes a pocketshell-cli change and the plan
  changes substantially.
- D13 The Pi session root is **discovered** (override →
  `$PI_CODING_AGENT_SESSION_DIR` → `$HOME/.pi-agent/sessions` →
  `$HOME/.pi/agent/sessions`), never hardcoded, because the target build uses
  a `.pi-agent` config dir (§9.1).

**Needed from the maintainer — status:**

- Q1 Environment — **resolved**: check out `pocketshell-core` at current
  `main` (the SHA pin is unrecoverable; the small drift risk is accepted). A
  real Pi session fixture is captured from the target server (§9). **Still
  open:** SSH credentials for `192.168.1.3` — SMB is fine for fixtures, but
  the app's transport is SSH, so connecting the app (and emulator
  acceptance) needs a login.
- Q2 Project discovery — **resolved**: derive from Pi session `cwd` headers,
  and allow adding a project by browsing to a directory and starting a
  session there (§9.1).
- Q3 Password auth — **resolved**: in v1 (§7.2).
- Q4 Acceptance environment — **partly resolved**: the Ubuntu server
  (`192.168.1.3`) is reachable and holds the data; still to confirm which
  machine runs the Android emulator/packaged-APK acceptance (this Windows
  box, or the Linux server) and its Android SDK.
- Q5 Send mechanism — **settled**: PTY-driven per earlier approval (§9.4);
  `pi -p` over exec remains a plan-time fallback if turns prove short.

## 13. How it gets built (next steps)

1. Restore the environment (§5): core checkout + `pnpm install` + Android SDK;
   typecheck the untouched tree to confirm the core pin compiles.
2. Execute the plan (`superpowers:writing-plans`) — sequenced, test-first:
   Pi parsing + discovery are pure and unit-testable without a device; vault
   and auth changes are native; screens are the phone layer.
3. Verification: JS unit gate for parsers/stores; a packaged debug APK on an
   emulator for the visual/interaction acceptance, per the repo's review bar.
