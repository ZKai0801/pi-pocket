# Android architecture

## 0.6.0 on `main`

`main` is the JS-first 0.6.0 app. Per D42 there is one shared core across
platforms. Each client (Android, desktop, web) owns only its platform code.

```text
vendor/pocketshell-core/    pinned submodule: shared TypeScript contract layer
                            (HostCliCore, ConnectionController, SshCapability,
                            composer, sync, usage/ports policy) and packages/ui
                            (shared tokens, themes, AppIcon, ComposerControls)
src/                        Vue app: chat components (components/, sessions/,
                            shell), pi/, session/, stores/, sync/, migration/,
                            and native/ (TypeScript wrappers for the
                            Capacitor plugins)
android/                    Capacitor host: MainActivity and the native plugins
                            (SshCapabilityPlugin, KeyboardInsetsPlugin,
                            SpeechRecognitionPlugin, DocumentContentPlugin,
                            InstalledDataMigrationPlugin)
tests/unit/                 Vitest suite (scripts/run-js-unit-gate.sh)
tests/docker/               disposable SSH and aplexer fixtures
```

The native SSH plugin implements core's `SshCapability`. Core's
`ConnectionController` owns host-key verdicts, host CLI calls, session
switching, reconnect and grace. The plugin moves bytes and reports transport
state. The phone app is chat-only (D45): it keeps exec/SFTP/PTY/forwards over
`SshCapability` and consumes no host-CLI surface (guard:
`tests/unit/noHostCliSurface.test.ts`). Host contract: SSH + `pi`; tmux
recommended (D44 degradation). See
[js-first-rewrite-foundation.md](js-first-rewrite-foundation.md),
[js-first-rewrite-inventory.md](js-first-rewrite-inventory.md) and
[design-system.md](design-system.md).

### Local backups (0.6.0)

Both 项目 and 会话 paint a local backup first and let the server's answer
replace it, because both reads are chains of SSH round trips a phone cannot
hide behind a spinner:

- `src/pi/projectCache.ts` — the host's last confirmed project list, in the
  WebView's localStorage (one small JSON record, keyed by host, 30-day TTL,
  8-host cap). A discovery paints it, then walks the session root; a listing
  that fails keeps the painted list and reports its error beside it
  (`stale`/`refreshing` on the projects store) instead of showing an empty
  error screen. Re-pointing a host's Pi directory drops its entry, since the
  list belongs to the old root.
- `src/pi/sessionListCache.ts` — a project's last confirmed 会话 rows on a
  host, in the same localStorage record shape (keyed by host **and** project
  path, 14-day TTL, 16 lists, 200 rows per list). `listSessions` is the
  slowest read in the app — one `tail` per session file — so entering a
  project paints these rows and lets the listing replace them; a failed sync
  keeps them (`stale`/`refreshing` on the sessions store). Re-pointing a
  host's Pi directory drops every list for that host, since their paths name
  files under the old root.
- `src/pi/recentSessionsCache.ts` — the conversations recently opened on a
  host, in the same localStorage record shape (keyed by host, 30-day TTL, 20
  entries). Not a paint for a listing but a shortcut into one: the 会话 tab
  shows these rows before any project is selected, so a cold start lands on
  the last conversation instead of the 先选择一个项目 hint. Every fresh read
  re-saves its entry — a cold open moves it to the top, a reply landing in an
  already-open chat only refreshes its row. Re-pointing a host's Pi directory
  drops its entries, since their paths name files under the old root.
- `src/pi/sessionCache.ts` — the parsed conversation, in IndexedDB, for the
  same reason at a larger size (spec §8.6).

No backup is ever a source of truth: every open and every discovery
re-reads the host.

## 0.5.x history (`release/0.5.x`)

**Everything below is 0.5.x history.** It describes the Kotlin `app2`
architecture, which now lives only on `release/0.5.x` and takes hotfixes only.
None of its modules exist on `main`.

On `release/0.5.x`, `app2` is the only Android application module, and the
host session runtime is aplexer. The product has one session contract; there
is no client-side session manager selection.

### Module layout

```text
app2/                      Compose application and composition root
shared/core-transport/     sshj connection, exec, PTY, SFTP, and forwarding channels
shared/core-hostapi/       JVM client for the host `pocketshell` JSON contract
shared/core-terminal/      vendored Termux terminal emulator and terminal view
shared/core-portfwd/       port discovery and tunnel supervision
shared/core-storage/       Room entities, DAOs, and migrations
shared/core-usage/         usage and quota models
shared/core-diagnostics/   diagnostic event bus, JSONL event store, recorder
shared/core-voice/         Whisper and Android speech input plumbing
shared/core-assistant/     assistant clients and encrypted configuration
shared/ui-kit/              shared visual primitives and theme
shared/test-support/        test-only coroutine and fixture helpers
pocketshell CLI             host-side Python CLI — its own repo:
                            PocketShell-io/pocketshell-cli (issue #2643)
tests/docker/               disposable SSH and aplexer fixtures
```

`core-transport` is the only production module that knows sshj. `core-hostapi`
is pure JVM code, so the host contract is tested against captured JSON without
an emulator. `core-terminal` contains the vendored emulator and the
PocketShell-specific PTY bridge helpers. The app owns screen state and connects
those modules through `ConnectionsRegistry`. `core-portfwd` auto-forwards
in-window ports once a supervisor is mounted; auto-forward resume is
`ProcessLifecycleOwner` `ON_START`, not a screen.

### Session contract

The app calls these host commands over SSH:

```text
pocketshell sessions list --json
pocketshell sessions create ...
pocketshell sessions attach <name-or-id>
pocketshell sessions kill <name-or-id>
```

The host CLI resolves every session through its bundled aplexer binary. Create
delegates to `a start`, attach replaces the PTY process with `a attach`, and kill
uses `a kill` followed by record cleanup. If aplexer is unavailable, the command
returns a named error; it does not search for another runtime.

The JSON document is schema 3. A row contains the aplexer identity, workspace,
tag, engine/profile metadata, agent state, attachment state, timestamps, and
the `phase`/`alive` liveness pair. The document may also contain `errors[]` for
an enumeration failure. Rows are emitted only while the aplexer workload is
live, so the Android tree never presents a stale attach target. There is no
`manager`, `backend`, or runtime discriminator in the row.

The PTY path is deliberately simple: `HostCliClient.attachCommand` builds one
quoted command, `TerminalPtyBridge` copies bytes between the SSH PTY and the
vendored terminal emulator, and `TerminalHostView` renders that emulator. The
client does not parse a multiplexer control protocol, enumerate sockets, or
maintain a second session state machine.

### Connection and reconnect

`RealHostConnectionFactory` is the single SSH dial site. A
`HostConnection` owns bounded exec, PTY, SFTP, and forwarding channels. A lost
or deliberately closed connection is spent; the caller creates a new one.
`ReconnectController` owns the finite retry ladder, while `GraceCoordinator`
and `GraceService` keep an active terminal connection alive for the bounded
background grace window. The remote aplexer workload survives that transport
close and is attached again when the app returns.

The terminal surface is not cleared during reconnect. The emulator keeps its
last rendered frame until the new PTY supplies bytes. No client-side pane
snapshot, socket sweep, or hidden legacy attach path exists.

### Agent state

The host derives an optional agent kind from the live aplexer workload's
descendant process tree and recent hook/log evidence. `core-hostapi` parses the
normalized fields; the Android session tree treats them as metadata and does
not invent a second source of session identity. Conversation history remains a
host-file concern and is not required to attach a terminal.

### Storage and the migration boundary

`core-storage` uses Room database schema 21. `HostEntity` stores SSH and
PocketShell capability state but no session-runtime installation flag.
`MIGRATION_20_21` rebuilds the `hosts` table from the current entity shape and
therefore drops the obsolete `tmuxInstalled` column.

The earlier migration SQL and exported schemas intentionally still contain the
literal `tmuxInstalled`. Those migrations describe databases that users may
already have on disk; Room must be able to open versions 1 through 20 before it
can run 20→21. The column is copied only as historical compatibility data and
is not represented in the current entity, DAO, app code, or schema 21 export.
The storage tests create old table shapes and verify that the 20→21 rebuild
removes it. Product grep checks therefore exclude only the historical migration
SQL and its exported schemas, with this section as the reason.

### Host helper packaging

The PyPI package pins aplexer and resolves the bundled `a` next to the Python
interpreter. A separately installed binary on `PATH` cannot become the product's
session runtime. The Docker `agents` image follows the same rule: it derives the
release from `tests/docker/fixture-pins.txt`, installs both `a` and its
`aplexer` worker, and runs a create → list → kill → gone self-check while the
image is built.

### Testing and operational boundary

J02, J03, J04, and J14 create or inspect real aplexer sessions in the Docker
fixture. The full Android journey lane runs against that image, while the JVM
and Python lanes test the same schema and command contract without a device.
See [testing.md](testing.md) for commands and evidence requirements.

The repository still uses tmux to isolate agent-runner and test processes. That
operational tooling is outside the product: its socket rules remain in
`AGENTS.md`, `process.md`, `scripts/`, and
[tmux-socket-recovery.md](tmux-socket-recovery.md). It must not be copied into
the host CLI, Android client, Docker product fixture, or user documentation.
