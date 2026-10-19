# PocketShell WeChat-UI Rebuild — Plan 2: Phone shell, three tabs, chat (read-only)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the app to one shell and ship the WeChat-style phone UI — a
bottom tab bar over Connections / Projects / Sessions, a read-only chat view
that renders a Pi session, and the retained terminal reachable as a secondary
screen. Chat *sending* is Plan 3; password auth and a remembered key passphrase
are Plan 4.

**Architecture:** `src/main.ts` stops choosing between two shells and mounts one
new root. Three new Pinia stores (`connections`, `projects`, `sessions`) own all
state; a small `src/pi/piTransport.ts` adapter implements Plan 1's `PiTransport`
over `ConnectionController`'s `exec` plus `sshCapability.sftpRead`, so every
decision stays unit-testable in Node behind a fake transport. Views are thin.

**Tech Stack:** Vue 3 SFC + Pinia, `@pocketshell/core` (`ConnectionController`,
`HostCliCore`, `hostKeyTrustCore`), Plan 1's `src/pi/`, `marked` + `dompurify`,
the shared UI kit at `@ui`, Capacitor 8.

**Spec:** `docs/superpowers/specs/2026-10-19-wechat-ui-pi-design.md` (§6, §7, §8, §9.1–9.3, §10)
**Predecessor:** `docs/superpowers/plans/2026-10-19-pi-foundation-data-layer.md`

## Global Constraints

- **One shell only.** `src/sharedApp/*`, its router/views, `src/shellSelection.ts`'s
  branch and `src/platform/android/{androidApi,connectionHub}.ts` are deleted; no
  second shell may survive (spec §4).
- **Reuse, don't re-implement** `ConnectionController`, `sshCapability`,
  `HostCliCore`/`hostCliSessions`, `hostKeyTrustCore`, `remotePathPolicy`. Never
  fork core (spec §4).
- **All colours / radii / shadows / motion come from tokens.** WeChat roles are
  added as a *phone layer* in `src/styles.css` (spec §10); `designTokens.test.ts`
  permits tokens declared there, and it fails the build on raw literals.
- **Chat renders only user text and assistant `text` blocks.** Never tool calls,
  tool results, thinking, bash or sub-agent traffic (spec §4, §9.3). Plan 1's
  `parsePiSession` already enforces this — do not re-parse.
- **Assistant text is untrusted remote content.** `marked` must have raw HTML
  disabled and its output must pass an allow-list sanitizer before `v-html`
  (spec §8.6). Links never auto-follow.
- **Session root is discovered, never hardcoded** (spec §9.1, D13): per-host
  override → `$PI_CODING_AGENT_SESSION_DIR` → `$HOME/.pi-agent/sessions` →
  `$HOME/.pi/agent/sessions`, first that exists.
- **Projects are keyed by the absolute `cwd`** from the Pi session header, never
  by Pi's lossy encoded directory name (spec §9.1, D3).
- **One live connection at a time** (D8): switching hosts closes the current one
  after a confirm.
- **Tap targets ≥ 48 px**; no new colour literals (spec §10).
- `vendor/pocketshell-core` stays pinned at `ea0a0df8`; no core edits.

## Review Focus

These follow from the spec but no task's happy path exercises them; each gets a
test in the task that owns the code.

1. A **v1 host record with a `keyHandleId` and no `auth`** must load as a key
   host with the handle intact, and a password host must be refused by
   `resolve` rather than dialled keyless — the additive shape is only safe if
   both halves hold.
2. `resolveSessionRoot` must **stop at the first candidate that exists** and must
   not treat a *file* as a root (a `.pi-agent/sessions` file is not a directory).
3. When the probe finds **no** candidate, the Projects tab shows an actionable
   "set the Pi sessions directory" state, not an empty list.
4. A `PiTransport` whose `exec` reports a non-zero exit must surface as an error
   in the store, not as an empty project/session list.
5. Sanitization must **survive a hostile assistant payload** — `<img onerror>`,
   `<script>`, `javascript:` links, and raw HTML in the markdown source — with
   no script node and no live handler reaching the DOM.

---

### Task 1: Extend `SavedHost` with an auth union (one storage key)

**Files:**
- Modify: `src/platform/android/hostStore.ts`
- Test: `tests/unit/hostStoreAuth.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type HostAuth = { kind: 'key'; keyHandleId: string } | { kind: 'password'; passwordCredentialId: string }`
  - `SavedHost` gains **optional** `auth?: HostAuth`, `piSessionsDir?: string`,
    `piCommand?: string`. The existing `keyHandleId: string` stays.
  - `validateSavedHost` accepts a password host (empty `keyHandleId` **and**
    `auth.kind === 'password'`).
  - `AndroidHostStore.resolve` refuses a password host with a clear error until
    Plan 4 supplies the secret.
  - **Rejected by ruling (R7):** a `SavedHostV2` type, a
    `pocketshell.android.hosts.v2` storage key, and a `migrateHostsV1`
    function. `src/platform/android/hostStore.ts:17` already owns the one key
    (`pocketshell.android.hosts.v1`) and `AndroidHostStore` the one store; ~20
    files read them. A second key or a parallel free-function API would create a
    second source of truth for saved hosts. A v1 record with `keyHandleId` and no
    `auth` **already is** a key host, so there is nothing to migrate.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/hostStoreAuth.test.ts
import { describe, expect, it } from 'vitest';
import { AndroidHostStore, validateSavedHost, type SavedHost } from '../../src/platform/android/hostStore';

function make(seed?: string) {
  const map = new Map<string, string>();
  if (seed) map.set('pocketshell.android.hosts.v1', seed);
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
  return new AndroidHostStore({ storage, readLegacyHosts: async () => [] });
}

describe('SavedHost auth', () => {
  it('loads a v1 record with no auth as a key host', () => {
    const seed = JSON.stringify([
      { name: 'kai', hostname: 'h', port: 22, user: 'kai', keyHandleId: 'h-1' },
    ]);
    expect(make(seed).savedHosts()).toEqual([
      { name: 'kai', hostname: 'h', port: 22, user: 'kai', keyHandleId: 'h-1' },
    ]);
  });

  it('round-trips a password host under the same storage key', () => {
    const store = make();
    const host: SavedHost = { name: 'p', hostname: 'h', port: 22, user: 'u', keyHandleId: '',
      auth: { kind: 'password', passwordCredentialId: 's-1' } };
    expect(validateSavedHost(host)).toBeNull();
    store.save(host);
    expect(store.savedHosts()[0]!.auth).toEqual({ kind: 'password', passwordCredentialId: 's-1' });
  });

  it('still requires a key for a key host', () => {
    expect(validateSavedHost({ name: 'k', hostname: 'h', port: 22, user: 'u', keyHandleId: '' }))
      .toMatch(/key/i);
  });

  it('keeps piSessionsDir and piCommand through a save', () => {
    const store = make();
    store.save({ name: 'k', hostname: 'h', port: 22, user: 'u', keyHandleId: 'h-1',
      piSessionsDir: '/home/projects/.pi-agent/sessions', piCommand: '/opt/bin/pi' });
    expect(store.savedHosts()[0]).toMatchObject({
      piSessionsDir: '/home/projects/.pi-agent/sessions', piCommand: '/opt/bin/pi',
    });
  });

  it('refuses to dial a password host until Plan 4 wires the secret', async () => {
    const seed = JSON.stringify([{ name: 'p', hostname: 'h', port: 22, user: 'u', keyHandleId: '',
      auth: { kind: 'password', passwordCredentialId: 's-1' } }]);
    await expect(make(seed).resolve({ host: 'h', user: 'u', hostAlias: 'p' }))
      .rejects.toThrow(/password|credential/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/hostStoreAuth.test.ts`
Expected: FAIL — a password host is rejected by `validateSavedHost` and the
extra fields are dropped by `save`.

- [ ] **Step 3: Implement**

Add the `HostAuth` type and the three optional fields to `SavedHost`; carry
`auth`, `piSessionsDir` and `piCommand` through `save`'s `record` object and
through `isSavedHost`; make `validateSavedHost` require a key handle only when
`auth?.kind !== 'password'`; and make `resolve` throw for a password host
(`MissingHostCredential` or a dedicated error) rather than dialing it keyless.
Update the doc comment at the top of the file, which currently says a host
"only names its handle". Secret material still never reaches `localStorage` —
only a `passwordCredentialId` (spec §7.1, D2).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/hostStoreAuth.test.ts`
Expected: PASS (5 tests).
Run: `npx vitest run tests/unit/androidHostKeys.test.ts tests/unit/androidPlatform.test.ts`
Expected: PASS — the additive change did not disturb the existing store tests.
Run: `npx vue-tsc --noEmit`
Expected: exit 0 — no consumer of `SavedHost` breaks (that is R7's whole point).

- [ ] **Step 5: Commit**

```bash
git add src/platform/android/hostStore.ts tests/unit/hostStoreAuth.test.ts
git commit -m "feat(hosts): an auth union on SavedHost, one storage key"
```

---

### Task 2: `resolveSessionRoot` — probe the candidates for real

**Files:**
- Create: `src/pi/resolveSessionRoot.ts`
- Modify: `src/pi/index.ts`
- Test: `tests/unit/piResolveSessionRoot.test.ts`

**Interfaces:**
- Consumes: `candidateSessionRoots` (Plan 1), `PiTransport` (Plan 1).
- Produces: `function resolveSessionRoot(transport: PiTransport, home: string, env: Record<string, string | undefined>, override?: string): Promise<string | null>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/piResolveSessionRoot.test.ts
import { describe, expect, it, vi } from 'vitest';
import { resolveSessionRoot } from '../../src/pi/resolveSessionRoot';
import type { PiTransport } from '../../src/pi/piRepository';

function exec(results: Record<string, string>) {
  return { exec: vi.fn(async (c: string) => ({ stdout: results[c] ?? '', stderr: '', exitCode: results[c] === undefined ? 1 : 0 })), sftpRead: vi.fn() };
}

describe('resolveSessionRoot', () => {
  it('returns the override when it exists as a directory', async () => {
    const t = exec({ "test -d '/srv/pi/sessions' && echo yes": 'yes\n' });
    expect(await resolveSessionRoot(t as unknown as PiTransport, '/home/kai', {}, '/srv/pi/sessions'))
      .toBe('/srv/pi/sessions');
  });

  it('falls through to the next candidate when one is missing', async () => {
    const t = exec({ "test -d '/home/kai/.pi-agent/sessions' && echo yes": 'yes\n' });
    expect(await resolveSessionRoot(t as unknown as PiTransport, '/home/kai', {}))
      .toBe('/home/kai/.pi-agent/sessions');
  });

  it('does not accept a file in place of a directory', async () => {
    const t = exec({ "test -d '/srv/x' && echo yes": '' });
    expect(await resolveSessionRoot(t as unknown as PiTransport, '/home/kai', {}, '/srv/x'))
      .toBe(null);
  });

  it('returns null when nothing exists', async () => {
    expect(await resolveSessionRoot(exec({}) as unknown as PiTransport, '/home/kai', {})).toBe(null);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/piResolveSessionRoot.test.ts`
Expected: FAIL — cannot resolve `../../src/pi/resolveSessionRoot`.

- [ ] **Step 3: Implement**

For each root from `candidateSessionRoots(home, env, override)`, build
`` `test -d ${quoteShell(root)} && echo yes` `` (reuse Plan 1's `quoteShell`;
never interpolate a raw path) and return the first whose stdout trims to `yes`.
`test -d` — not `ls` — so a file is rejected (Review Focus 2). Return `null`
when none match. Add a `resolveSessionRootCommand(root)` builder to
`src/pi/piCommands.ts` so the string is testable, and re-export the function from
`src/pi/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/piResolveSessionRoot.test.ts`
Expected: PASS (4 tests).
Run: `pnpm exec vitest run tests/unit/piCommands.test.ts`
Expected: PASS — the new builder did not change an existing command string.

- [ ] **Step 5: Commit**

```bash
git add src/pi/resolveSessionRoot.ts src/pi/piCommands.ts src/pi/index.ts tests/unit/piResolveSessionRoot.test.ts tests/unit/piCommands.test.ts
git commit -m "feat(pi): probe the candidate session roots for the first that exists"
```

---

### Task 3: The `PiTransport` adapter over the live connection

**Files:**
- Create: `src/pi/piTransport.ts`
- Test: `tests/unit/piTransport.test.ts`

**Interfaces:**
- Consumes: the **shipped** `PiTransport` — `src/pi/piRepository.ts:11-17`:
  `exec(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null }>`
  and `sftpRead(path: string, maxBytes: number): Promise<string>`.
- Produces:
  - `interface PiExecTarget { exec(command: string, options: { timeoutMs: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null }> }`
  - `interface PiSftpReader { sftpRead(options: { path: string; maxBytes: number }): Promise<{ dataBase64: string }> }`
  - `function createPiTransport(exec: PiExecTarget, sftp: PiSftpReader): PiTransport`
  - `function decodeBase64Utf8(dataBase64: string): string`
- **This module is a seam between two deliberately different shapes** (R5): the
  native Capacitor bridge only accepts a single options object and hands back a
  base64 envelope, while the shipped `PiTransport` takes `(command, timeoutMs)`
  positionally and returns decoded `string`. The adapter is where those are
  reconciled; do not "fix" either side to match the other.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/piTransport.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createPiTransport, decodeBase64Utf8 } from '../../src/pi/piTransport';

describe('createPiTransport', () => {
  it('forwards exec verbatim', async () => {
    const exec = { exec: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })) };
    const t = createPiTransport(exec, { sftpRead: vi.fn() });
    expect(await t.exec('ls', 15000)).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(exec.exec).toHaveBeenCalledWith('ls', { timeoutMs: 15000 });
  });

  it('decodes an sftpRead base64 payload as UTF-8 text', async () => {
    const sftp = { sftpRead: vi.fn(async () => ({ dataBase64: Buffer.from('{"a":1}\n').toString('base64') })) };
    const t = createPiTransport({ exec: vi.fn() }, sftp);
    expect(await t.sftpRead('/x.jsonl', 262144)).toBe('{"a":1}\n');
    expect(sftp.sftpRead).toHaveBeenCalledWith({ path: '/x.jsonl', maxBytes: 262144 });
  });

  it('decodes multi-byte UTF-8 across the base64 boundary', () => {
    expect(decodeBase64Utf8(Buffer.from('中文 🎉').toString('base64'))).toBe('中文 🎉');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/piTransport.test.ts`
Expected: FAIL — cannot resolve `../../src/pi/piTransport`.

- [ ] **Step 3: Implement**

`exec` forwards to the injected target unchanged (the capability has no
`connectionId` of its own once bound; the caller passes the bound object).
`sftpRead` calls `{ path, maxBytes }` and decodes `dataBase64` with
`decodeBase64Utf8`. Implement `decodeBase64Utf8` with `Uint8Array` +
`TextDecoder('utf-8')` — **not** `atob` + `decodeURIComponent`, so multi-byte
characters and emoji survive. This module must import nothing native.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/piTransport.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pi/piTransport.ts tests/unit/piTransport.test.ts
git commit -m "feat(pi): adapt the live connection to the PiTransport seam"
```

---

### Task 4: Phone token layer + the tab bar

**Files:**
- Modify: `src/styles.css` (append a `:root` phone-token block)
- Create: `src/components/shell/AppTabBar.vue`
- Test: `tests/unit/phoneTokens.test.ts`

**Interfaces:**
- Consumes: `@ui` tokens (`tokens.css`).
- Produces: phone tokens `--chat-bg`, `--bubble-self-bg`, `--bubble-self-fg`,
  `--bubble-other-bg`, `--bubble-other-fg`, `--tabbar-active`, `--tabbar-bg`,
  `--tabbar-fg`; and `AppTabBar.vue` with props
  `{ modelValue: 'connections' | 'projects' | 'sessions'; }` emitting `update:modelValue`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/phoneTokens.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
const REQUIRED = ['--chat-bg', '--bubble-self-bg', '--bubble-self-fg',
  '--bubble-other-bg', '--bubble-other-fg', '--tabbar-active', '--tabbar-bg', '--tabbar-fg'];

describe('phone token layer', () => {
  it('declares every WeChat role the phone UI needs', () => {
    for (const token of REQUIRED) expect(css).toContain(`${token}:`);
  });
  it('declares them from existing tokens, not raw hex', () => {
    const block = css.slice(css.indexOf('--chat-bg:'));
    for (const token of REQUIRED) {
      const line = block.split('\n').find((l) => l.trim().startsWith(`${token}:`));
      expect(line, token).toBeDefined();
      expect(line, token).toMatch(/var\(--/);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/phoneTokens.test.ts`
Expected: FAIL — the tokens are absent.

- [ ] **Step 3: Implement the token block and the tab bar**

Append a `:root { … }` block to `src/styles.css` defining each token **in terms
of existing `--` tokens** (Review Focus 5 and spec §10: no raw hex). Then build
`src/components/shell/AppTabBar.vue`: a fixed bottom bar, three items
(连接 / 项目 / 会话) with an `@ui` `AppIcon` + label, the active item tinted with
`--tabbar-active`, tap targets ≥ 48 px, respecting the existing
`--android-shell-safe-*` bottom inset. Use only `AppIcon` names that already
exist — do not add a glyph to core (spec §8.1).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/phoneTokens.test.ts tests/unit/designTokens.test.ts`
Expected: PASS (both) — the design-token guard permits phone-layer tokens.

- [ ] **Step 5: Commit**

```bash
git add src/styles.css src/components/shell/AppTabBar.vue tests/unit/phoneTokens.test.ts
git commit -m "feat(ui): phone token layer and the three-tab bottom bar"
```

---

### Task 5: Mount the single phone shell

**Files:**
- Create: `src/phone/PhoneApp.vue`
- Modify: `src/main.ts`, `capacitor.config.ts`, `tests/unit/durableStorage.test.ts`,
  `tests/unit/designTokens.test.ts`
- Test: `tests/unit/phoneShellSingleEntry.test.ts`
- **No deletions** — see Ruling R13.1.

**Interfaces:**
- Consumes: `AppTabBar.vue` (Task 4), the stores from Tasks 6–8, the seams
  `installConnectionPort` (Task 6), `installPiLive` (Task 7), `installTerminalPty`
  (Task 9), and `TerminalScreen.vue` (Task 9).
- Produces: one root mounted by `src/main.ts`; `PhoneApp.vue` owns the active
  tab, lays out the tab bar above the active tab's view, owns the live
  connection, and hosts the terminal overlay.

> **Ruling R13 (preflight):** the earlier text of this task said "collapse the two
> shells into one" and deleted `src/sharedApp/**`, `src/shellSelection.ts`,
> `src/platform/android/androidApi.ts` and `src/platform/android/connectionHub.ts`.
> That is wrong for this task; it is split as follows.
>
> **R13.1 — Scope split with Task 10.** `tsconfig.json` includes `tests/**/*.ts`,
> so `vue-tsc` typechecks tests: deleting a module breaks `pnpm typecheck` until
> every test that imports it is deleted too. `src/sharedApp/**` (6 test files),
> `androidApi.ts` (~9) and `connectionHub.ts` (3) account for ~15 dependent test
> files between them. Doing that here would make this task unreviewable and would
> duplicate Task 10's stated job (reconcile `scripts/js-unit-test-manifest.json`).
> So **Task 5 deletes nothing** and Task 10's delete list grows by
> `src/sharedApp/**`, `src/shellSelection.ts`, `src/legacyMain.ts`,
> `src/platform/android/androidApi.ts`, `src/platform/android/connectionHub.ts`.
> Task 5's job is the opposite: make the new shell the only *mount path*, leaving
> the old trees on disk but unreferenced until Task 10 removes them.
>
> **R13.2 — Entry contract (`src/main.ts`).** Must keep the three static CSS
> imports (`@ui/styles.css`, `@xterm/xterm/css/xterm.css`, `./styles.css` — the
> sole definition site of `.app-shell` and the WeChat token layer), keep the
> `bridgeWarmUp()` → `installAndroidDurableStorage()` order, and import+mount the
> phone app **dynamically after** that install (the stores read `localStorage` at
> import time; the old `legacyMain`/`sharedApp` dynamic import existed for exactly
> this). It must still call `applySharedUiDefaults(document.documentElement)`,
> create pinia, and call `installAndroidPlatformServices(app, window)` minus
> whatever only served `androidApi`. No `selectShell`; no static `App.vue` or
> `PhoneApp` import.
>
> **R13.3 — `capacitor.config.ts`.** Drop `appStartPath: '/?shell=shared'` so the
> WebView loads `/`.
>
> **R13.4 — `MainActivity.java`: leave untouched.** There is no Java toolchain in
> this environment (no JDK/ANDROID_HOME ⇒ unverifiable), and the stale
> `?shell=shared` query is inert once `main.ts` ignores it. Removing `EXTRA_SHELL`
> / the start-path override and the `SharedAppDockerJourney*` journeys is a
> **Plan 5 carry-forward**.
>
> **R13.5 — `PhoneApp.vue` responsibilities.** This is where R12's carry-forwards
> land:
> - tab state + `AppTabBar` + the three tab views (`ConnectionsList`,
>   `ProjectsList`, `SessionList`/`ChatScreen`);
> - **owns the live connection**: constructs the repo-local
>   `ConnectionController` (from `src/session/connectionController.ts`, bound to
>   `sshCapability`) with a trust store built from the legacy
>   `readStoredPin`/`pinStoreKey` helpers, then installs the three seams
>   (`installConnectionPort`, `installPiLive`, `installTerminalPty`) and releases
>   them on disconnect/unmount;
> - **host-key trust prompt** (Task 6 gap: `ConnectionsList.vue` has none — the
>   flow exists only in `App.vue` and `connectionHub.ts`): subscribe to
>   `controller.getSnapshot()`, render the core `HostKeyTrustPrompt` when the
>   phase is `awaiting-trust`, driven by `hostKeyCard(trustDecision, draft)`
>   (`App.vue:343-345`), with handlers calling
>   `controller.acceptPresentedHostKey({ passphrase, persist })`
>   (`App.vue:946-996`); after an accept, re-dial through the connections store
>   (the pin is now recorded). Port the bookkeeping from `App.vue`, do not
>   reinvent it;
> - **terminal overlay** (R12.1): mount `TerminalScreen.vue` over the shell and
>   add the 打开终端 trigger to the project/session header — `ProjectsList.vue`
>   and `ChatScreen.vue` emit `open-terminal` with the workspace path; `PhoneApp`
>   maps that path to an aplexer session name by basename (v1; flagged for
>   dogfood sign-off);
> - the `.app-shell` root attributes and the safe-area /
>   `--safe-area-inset-bottom` writers (`App.vue:1409-1419`) that the tab bar's
>   `--android-shell-safe-bottom` fallback needs.
>
> **R13.6 — Test changes.** `phoneShellSingleEntry.test.ts` keeps tests 1–2 but
> **drops test 3** ("the two removed shells are gone from disk") — deletions are
> Task 10's, and asserting them here would fail while `src/sharedApp` still
> exists. `tests/unit/durableStorage.test.ts:261-275` is rewritten from the
> two-shell shape to the single-shell shape (dynamic `./phone/PhoneApp.vue`
> imported after the durable-storage install). `tests/unit/designTokens.test.ts`
> extends `phoneStyleSources()` to scan `src/phone/*.vue` so the new shell is
> token-gated.
>
> **R13.7 — Carry-forwards:** Task 9's `resizeFailure`
> no-feedback-loop minor; the seam-internal detach/attach race; and the
> double-dial after a host-key accept (acceptable in v1, recorded for dogfood).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/phoneShellSingleEntry.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('single shell', () => {
  it('main.ts mounts the phone app unconditionally', () => {
    const main = read('../../src/main.ts');
    expect(main).toContain('./phone/PhoneApp.vue');
    expect(main).not.toContain('sharedApp');
    expect(main).not.toContain('selectShell');
  });
  it('capacitor starts on the phone app, not a shell query', () => {
    expect(read('../../capacitor.config.ts')).not.toContain('shell=shared');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/phoneShellSingleEntry.test.ts`
Expected: FAIL — `main.ts` still branches on `selectShell`.

- [ ] **Step 3: Implement the mount**

Rewrite `src/main.ts` per R13.2 to `bridgeWarmUp()` →
`installAndroidDurableStorage()` → dynamic `import('./phone/PhoneApp.vue')` →
`createApp` with `createPinia()`, `applySharedUiDefaults`, and the existing
platform-services install (keep the three CSS imports; keep
`installAndroidPlatformServices` minus the `androidApi`-only parts). Remove the
`server.appStartPath` shell query from `capacitor.config.ts` (R13.3). Create
`src/phone/PhoneApp.vue` per R13.5. **Do not delete any file** (R13.1);
`MainActivity.java` is untouched (R13.4).

- [ ] **Step 4: Run the test and the typecheck**

Run: `pnpm exec vitest run tests/unit/phoneShellSingleEntry.test.ts`
Expected: PASS (2 tests).
Run: `pnpm typecheck`
Expected: exit 0 — the new shell imports only live modules; the old trees remain
on disk but must now be unreferenced by `main.ts`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(shell): mount the single phone shell"
```

---

### Task 6: Connections tab — list and editor (key auth)

**Files:**
- Create: `src/stores/connections.ts`
- Create: `src/components/connections/ConnectionsList.vue`
- Create: `src/components/connections/ConnectionEditor.vue`
- Test: `tests/unit/connectionsStore.test.ts`

**Interfaces:**
- Consumes: `AndroidHostStore` and `SavedHost` (Task 1, `src/platform/android/hostStore.ts`), the existing `androidHosts` singleton (`src/platform/android/hosts.ts`), `hostKeyCard.ts`.
- Produces:
  - `interface ConnectionPort { connect(target: SshHostTarget): Promise<{ ok: boolean }>; disconnect(): Promise<void> }`
  - `type ConnectionsHosts = Pick<AndroidHostStore, 'savedHosts' | 'save' | 'remove' | 'resolve'>`
  - `function createConnectionsStore(deps: { hosts: ConnectionsHosts; port: ConnectionPort }): ConnectionsStore`
  - `useConnectionsStore()` — the Pinia wrapper binding `androidHosts`; its `port` comes from `installConnectionPort(port)` at `src/session/connectionPort.ts`, which Task 5 calls when the single shell owns the live connection.
  - State `{ hosts: SavedHost[]; activeName: string | null; status: 'idle' | 'connecting' | 'connected' | 'error'; lastError: string | null }`; actions `load()`, `save(host)`, `remove(name)`, `connect(name)`, `disconnect()`; `statusFor(name): 'connected' | 'idle'` — only `activeName` can be `connected` (D8).
- **Deviations from this plan's earlier text (rulings R7/R8):** there are no
  `readHosts`/`writeHosts` free functions and no `SavedHostV2` — Task 1 kept the
  single `AndroidHostStore` (methods `savedHosts`/`save`/`remove`/`resolve`) and
  the single storage key. The store therefore depends on **`AndroidHostStore`'s
  method surface**, not on free functions. And rather than coupling this store
  to the large core `ConnectionController`, it takes a **narrow injected
  `ConnectionPort`**; `AndroidHostStore.resolve()` already returns the
  `SshHostTarget` (with its credential) that the port consumes.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/connectionsStore.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createConnectionsStore } from '../../src/stores/connections';

const kai = { name: 'kai', hostname: '192.168.1.3', port: 22, user: 'kai', keyHandleId: 'h-1' };
const other = { name: 'other', hostname: '10.0.0.9', port: 22, user: 'root', keyHandleId: 'h-2' };

function deps(over: Record<string, unknown> = {}) {
  const hosts = {
    savedHosts: () => [kai, other],
    save: vi.fn(),
    remove: vi.fn(),
    resolve: vi.fn(async (request: { hostAlias?: string }) => ({
      hostId: `${request.hostAlias}@192.168.1.3:22`,
      hostname: '192.168.1.3', port: 22, username: 'kai',
      credential: { kind: 'key-handle', handleId: 'h-1' },
    })),
  };
  const port = { connect: vi.fn(async () => ({ ok: true })), disconnect: vi.fn(async () => {}) };
  return { hosts, port, ...over };
}

describe('connections store', () => {
  it('loads the saved hosts, none of them connected', () => {
    const store = createConnectionsStore(deps() as never);
    store.load();
    expect(store.hosts).toHaveLength(2);
    expect(store.statusFor('kai')).toBe('idle');
    expect(store.status).toBe('idle');
  });

  it('only the active host reports connected', async () => {
    const store = createConnectionsStore(deps() as never);
    await store.connect('kai');
    expect(store.statusFor('kai')).toBe('connected');
    expect(store.statusFor('other')).toBe('idle');
  });

  it('dials the resolved target, not the raw record', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    expect(d.hosts.resolve).toHaveBeenCalledWith({ host: '192.168.1.3', port: 22, user: 'kai', hostAlias: 'kai' });
    expect(d.port.connect).toHaveBeenCalledWith(
      expect.objectContaining({ credential: { kind: 'key-handle', handleId: 'h-1' } }),
    );
  });

  it('closes the current connection before opening another (D8)', async () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    await store.connect('other');
    expect(d.port.disconnect).toHaveBeenCalledTimes(1);
    expect(store.activeName).toBe('other');
    expect(store.statusFor('kai')).toBe('idle');
  });

  it('surfaces a dial failure as error status, not a throw', async () => {
    const d = deps();
    d.port.connect = vi.fn(async () => { throw new Error('auth failed'); });
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    expect(store.status).toBe('error');
    expect(store.lastError).toContain('auth failed');
    expect(store.activeName).toBeNull();
  });

  it('reports a missing credential instead of dialling', async () => {
    const d = deps();
    d.hosts.resolve = vi.fn(async () => { throw new Error('No SSH key is chosen'); });
    const store = createConnectionsStore(d as never);
    await store.connect('kai');
    expect(store.status).toBe('error');
    expect(d.port.connect).not.toHaveBeenCalled();
  });

  it('saves and removes through the host store', () => {
    const d = deps();
    const store = createConnectionsStore(d as never);
    store.save({ ...kai, name: 'renamed' });
    expect(d.hosts.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'renamed' }));
    store.remove('kai');
    expect(d.hosts.remove).toHaveBeenCalledWith('kai');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectionsStore.test.ts`
Expected: FAIL — cannot resolve `../../src/stores/connections`.

- [ ] **Step 3: Implement the store, then the two views**

`createConnectionsStore(deps)` takes its dependencies as arguments so it is
testable without Pinia or a device; `load()` reads `hosts.savedHosts()`.
`connect(name)` finds the record, `disconnect()`s any current host first,
resolves the dial target via `hosts.resolve({ host, port, user, hostAlias: name })`
and hands it to `ports.connect` — a `resolve` failure and a `connect` failure
both land as `status: 'error'` + `lastError`, never a throw, and neither leaves
`activeName` set. Then build the list (green/red dot, name, `host · user`, key
glyph, `…` for edit/delete, `+`, empty state with a big 新增连接 button) and the
editor (name, host, port, user, auth method; key picker from
`listSshKeys()`; **Pi sessions directory** and **pi command** fields per spec
§9.1). Verify `KeyIcon.vue` and core's `HostKeyTrustPrompt.vue` exist before
importing them; if a glyph or component does not exist, choose the nearest
existing one rather than adding to the pinned core. Wire an unknown host key
through `hostKeyCard.ts`. Every style must satisfy `tests/unit/designTokens.test.ts`
(tokens only — no colour literals, no undefined `var()`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/connectionsStore.test.ts`
Expected: PASS (7 tests).
Run: `npx vitest run tests/unit/designTokens.test.ts`
Expected: PASS — the new components' styles are token-only.
Run: `npx vue-tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/stores/connections.ts src/session/connectionPort.ts src/components/connections tests/unit/connectionsStore.test.ts
git commit -m "feat(connections): saved-host list and editor backed by a store"
```

---

### Task 7: Projects tab — discovery, search, refresh, add

**Files:**
- Create: `src/stores/projects.ts`
- Create: `src/session/piLive.ts`
- Create: `src/components/projects/ProjectsList.vue`
- Test: `tests/unit/projectsStore.test.ts`

**Interfaces:**
- Consumes: `PiRepository`, `resolveSessionRoot`, `PiTransport` (Tasks 2–3).
- Produces:
  - `useProjectsStore()` with `{ projects: PiProject[]; state: 'idle' | 'loading' | 'ready' | 'no-root' | 'error'; error: string | null; query: string }`, actions `discover()`, `setQuery(q)`, `addProject(path)`, getter `filtered`.
  - `state === 'no-root'` when `resolveSessionRoot` returns `null` (Review Focus 3).
- **Deviations from this plan's earlier text (ruling R9):** the real seam is
  thicker than the interface above.
  1. `listProjects` takes the **resolved root**: `listProjects(root: string)`.
     `PiRepository` is root-bound at construction
     (`src/pi/piRepository.ts:58-62`), so the real binding is
     `new PiRepository(transport, root).listProjects()`; re-probing inside
     `listProjects` would double the root discovery. The Step 1 tests pass
     unchanged: their `vi.fn`s ignore the extra argument.
  2. The factory takes two **optional** dependencies beyond the two above.
     `added?: { load(): Promise<string[]>; save(paths: string[]): Promise<void> }`
     — per-host persistence of manually added projects (spec §9.1: an added
     project is "listed even before it has a session" and must survive a
     refresh). The Pinia wrapper binds a localStorage implementation under the
     single key `pocketshell.android.pi.addedProjects.v1`
     (`Record<hostName, string[]>`), keyed by the connections store's active
     host. `discover()` merges discovered + added, de-duped by `path`,
     discovered first. An `added.load()` failure degrades to an empty list;
     it does not fail discovery.
     `browse?: { home(): Promise<string>; listDirs(path: string): Promise<PiDirectoryEntry[]> }`
     — the server directory browser behind 新增项目 (spec §9.1: "native
     `sftpList`, rooted at `$HOME`"; native `sftpList` is implemented at
     `SshCapabilityPlugin.java:798`).
  3. The live-connection side comes from a new seam `src/session/piLive.ts`
     (installed by the Task 5 shell, the same pattern as Task 6's
     `connectionPort.ts`):
     `interface PiLive { transport(): PiTransport; remoteContext(): Promise<{ home: string; env: Record<string, string | undefined> }>; listDirectories(path: string): Promise<PiDirectoryEntry[]> }`
     plus `installPiLive(live: PiLive | null): void` and `piLive(): PiLive`
     (throws while uninstalled). `type PiDirectoryEntry = { name: string; path: string }`
     — directories only, sorted by name. `resolveSessionRoot(transport, home, env, override)`
     needs the remote `$HOME` and env (at minimum
     `PI_CODING_AGENT_SESSION_DIR`, `src/pi/sessionRoot.ts:1`), which only the
     shell's live connection can answer; the per-host `override` is the active
     `SavedHost.piSessionsDir`. The Pinia wrapper binds `resolveRoot` and
     `listProjects` **lazily** (at call time) through `piLive()`.
     `discover()` with no installed seam (or no live connection) lands in
     `state: 'error'` with a "connect first" message (spec §8.4) — never a
     throw.
  4. The store also carries `selected: string | null` + `select(path)`
     (spec §8.5 "requires a selected project"; Task 8's
     `sessions.load(project)` reads it) and the browser state and actions:
     `browse: { open: boolean; cwd: string | null; dirs: PiDirectoryEntry[] | null; error: string | null; busy: boolean }`,
     `openBrowse()` (rooted at `browse.home()`), `browseEnter(path)`,
     `browseUp()` (parent computed locally, clamped at the browser root),
     `closeBrowse()`. `addProject(path)` also closes the browser.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/projectsStore.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createProjectsStore } from '../../src/stores/projects';

const deps = (over: Partial<Record<string, unknown>> = {}) => ({
  resolveRoot: vi.fn(async () => '/root'),
  listProjects: vi.fn(async () => [{ path: '/home/kai', name: 'kai' }]),
  ...over,
});

describe('projects store', () => {
  it('loads the discovered projects', async () => {
    const store = createProjectsStore(deps() as never);
    await store.discover();
    expect(store.state).toBe('ready');
    expect(store.projects).toEqual([{ path: '/home/kai', name: 'kai' }]);
  });

  it('reports no-root when the probe finds nothing', async () => {
    const store = createProjectsStore(deps({ resolveRoot: vi.fn(async () => null) }) as never);
    await store.discover();
    expect(store.state).toBe('no-root');
  });

  it('reports error, not an empty list, when discovery fails', async () => {
    const store = createProjectsStore(deps({ listProjects: vi.fn(async () => { throw new Error('exec 255'); }) }) as never);
    await store.discover();
    expect(store.state).toBe('error');
    expect(store.error).toContain('exec 255');
    expect(store.projects).toEqual([]);
  });

  it('filters by path and name case-insensitively', async () => {
    const store = createProjectsStore(deps({ listProjects: vi.fn(async () => [
      { path: '/home/kai', name: 'kai' }, { path: '/home/projects/auto_sci', name: 'auto_sci' }]) }) as never);
    await store.discover();
    store.setQuery('SCI');
    expect(store.filtered.map((p) => p.name)).toEqual(['auto_sci']);
  });

  it('lists an added project before it has any session', async () => {
    const store = createProjectsStore(deps({ listProjects: vi.fn(async () => []) }) as never);
    await store.discover();
    store.addProject('/home/projects/new');
    expect(store.filtered.map((p) => p.name)).toEqual(['new']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/projectsStore.test.ts`
Expected: FAIL — cannot resolve `../../src/stores/projects`.

- [ ] **Step 3: Implement the store, then the view**

`createProjectsStore({ resolveRoot, listProjects })` — dependencies injected for
testability. `discover()` sets `loading`, resolves the root, and either records
`no-root` (Review Focus 3), `error` (Review Focus 4), or `ready` with the
projects. `filtered` matches `query` against `path` and `name`,
case-insensitively. `addProject(path)` inserts a locally-added project
(deriving `name` from the basename) so it lists before its first session
(spec §9.1). The view renders a folder glyph, name, mono path, a search box and
pull-to-refresh; the existing `sftpList`-backed directory browser is wired to
`addProject` (native `sftpList` is already implemented — the removed shared
app's `unsupported` sftp group was the only blocker).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/projectsStore.test.ts`
Expected: PASS (the 5 plan tests plus the R9 additions: the root-bound
`listProjects(root)` call, `added` merge + de-dup, browse open/enter/up and
adding from the browse cwd, `discover()` erroring when no seam is installed,
and `select`). Still exactly one top-level `describe`.

- [ ] **Step 5: Commit**

```bash
git add src/stores/projects.ts src/session/piLive.ts src/components/projects tests/unit/projectsStore.test.ts
git commit -m "feat(projects): discover, filter and add Pi projects"
```

---

### Task 8: Sessions tab and the read-only chat

**Files:**
- Create: `src/stores/sessions.ts`
- Create: `src/components/sessions/SessionList.vue`
- Create: `src/components/sessions/ChatScreen.vue`
- Create: `src/components/sessions/ChatBubble.vue`
- Create: `src/chat/markdown.ts`
- Test: `tests/unit/sessionsStore.test.ts`, `tests/unit/chatMarkdown.test.ts`

**Interfaces:**
- Consumes: `PiRepository.listSessions`/`readSession`, `sessionPreview`,
  `ParsedPiSession` (Plan 1).
- Produces:
  - `useSessionsStore()` with `{ sessions: PiSessionMeta[]; open: ParsedPiSession | null; state: 'idle' | 'loading' | 'ready' | 'error'; error: string | null }`, actions `load(project)`, `openSession(path)`, `refresh()`.
  - `renderChatMarkdown(src: string): string` in `src/chat/markdown.ts`.
- **Deviations from this plan's earlier text (ruling R11):** the interface above
  holds for the factory; the wrapper and the views carry the rest.
  1. Landed contracts (Plan 1): `PiSessionMeta` is exactly
     `{ path; id; name: string | null; updatedAtMs; preview: string | null; turnCount }`
     (`src/pi/piRepository.ts:24`), and `PiRepository.readSession(path)` already
     returns `Promise<ParsedPiSession>` (sftpRead with an exec-tail fallback,
     parsed in-repo; `piRepository.ts:126`). The wrapper's `readSession`
     binding is therefore `repo.readSession(path)` with no further parsing.
     Both bindings need a `PiRepository` constructed with the **resolved root**,
     so the wrapper resolves the root per call, exactly like the Task 7 wrapper
     (`src/stores/projects.ts:356-369`): `piLive().remoteContext()` + the active
     host's `piSessionsDir` override + `resolveSessionRoot`; a `null` root or an
     uninstalled seam surfaces as `state: 'error'`, never a throw. Re-probing the
     root per call is acceptable for v1 (with the per-host override it is one
     `test -d` exec).
  2. Additions to the store state/actions (the Step 1 tests pin the core;
     house-style additions get tests too): `openPath: string | null` (the open
     session's file path — `ParsedPiSession` carries no path, and the chat's
     pull-to-refresh re-reads it), `lastProject: PiProject | null`, a
     `closeChat()` action (back navigation: clears `open`/`openPath`), and
     `refresh()` semantics: re-read `openSession(openPath)` when a chat is open,
     else `load(lastProject)`, else no-op. `load`/`openSession` are
     re-entrancy-guarded; an `openSession` failure sets `state: 'error'` and
     leaves the previous `open` intact.
  3. Host switching (D8): the wrapper watches
     `useConnectionsStore().activeName` and clears `sessions`, `open`,
     `openPath`, `lastProject`, `error`, `state → 'idle'` — a stale host's list
     or chat must never render. It also watches `useProjectsStore().selected`:
     a non-null value `load`s `{ path: selected, name: basename(selected) }`
     (the basename matches `PiRepository`'s `projectNameFromPath`); the Task 7
     watch already clears `selected` on host switch.
  4. Title (R4: the landed contract wins): the row title is `meta.name` (the Pi
     `session_info` name) when non-null, else `meta.id`. The spec §8.5/§9.2
     "first user text" title/fallback is not available on `PiSessionMeta` —
     Plan 1's `listSessions` parses only a 64 KiB tail and its tests pin
     `name` to the `session_info` value only — so it is recorded as a Plan 1
     spec deviation, not a Task 8 defect. The chat screen title is
     `open.name ?? open.id`. `meta.preview` already is the last assistant text
     (120 chars, `sessionPreview`).
  5. Navigation is store-driven: the chat screen shows while
     `store.open !== null`; back calls `closeChat()`. The views are
     self-contained for the Task 5 tab embed; the legacy `useNavigationStore`
     route stack is not involved.
  6. Markdown: `marked` is already a dependency (`^18.0.14`) — verify the
     installed version's renderer/token API before overriding the `html` token
     (emit nothing) and the `link` token (emit the anchor text as plain text,
     no `<a>`, no href — spec §8.6 "links render as text", and Review Focus 5's
     `javascript:` case cannot reach the output because no URL is emitted).
     `DOMPurify.sanitize` allow-list: `p, br, strong, em, del, code, pre, ul,
     ol, li, blockquote` (no `a`, no `img`). Fenced code comes out as
     `<pre><code>` escaped by marked. Both bubble kinds render through
     `renderChatMarkdown` (sanitized) so pasted code in user messages gets mono
     blocks.
  7. DOMPurify needs a DOM; the root app's vitest environment is `node`
     (`vitest.config.ts:24`) with no jsdom installed. Extend the R3 install:
     `npx pnpm@12.5.1 add dompurify` (dependencies), `npx pnpm@12.5.1 add -D
     jsdom` (devDependencies; the vendor UI kit's per-file convention is a
     `// @vitest-environment jsdom` comment on the test's first line),
     `@types/dompurify` (devDependencies) only if `vue-tsc` reports the package
     untyped. Commit `package.json` + `pnpm-lock.yaml` with the task.
  8. Views: token-only, Chinese labels, 48 px tap targets, `AppIcon.vue`
     glyphs only. `SessionList.vue`: no selected project → empty state
     "先选择一个项目" (spec §8.5); selected project with zero sessions → an
     empty state naming the project; row = title, one/two-line truncated
     preview, relative time (a small pure `relativeTime` helper: 刚刚 / N 分钟 /
     N 小时 / N 天 / date); the `+` control is present but inert (stubbed until
     Plan 3). `ChatScreen.vue`: header (back `arrow-left`, title), scrolling
     bubbles, timestamps as subtle separators, touch pull-to-refresh that
     re-reads the open session (the Task 7 pattern), and the composer bar
     present but disabled with a Chinese hint (placeholder
     "消息发送将在后续版本提供") — no send path. `ChatBubble.vue`: user right on
     `--accent`/`--on-accent`, assistant left on `--surface`/`--fg`, code in
     `--font-mono`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/chatMarkdown.test.ts
import { describe, expect, it } from 'vitest';
import { renderChatMarkdown } from '../../src/chat/markdown';

describe('renderChatMarkdown', () => {
  it('renders emphasis and a fenced code block', () => {
    const html = renderChatMarkdown('**hi**\n\n```sh\nls -la\n```');
    expect(html).toContain('<strong>hi</strong>');
    expect(html).toContain('<code');
  });

  it('drops raw html from the source', () => {
    expect(renderChatMarkdown('<img src=x onerror=alert(1)>')).not.toContain('onerror');
  });

  it('strips script nodes and event handlers', () => {
    const html = renderChatMarkdown('<script>alert(1)</script><b onclick="x()">b</b>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
  });

  it('neutralises a javascript: link', () => {
    expect(renderChatMarkdown('[x](javascript:alert(1))')).not.toContain('javascript:');
  });
});
```

```ts
// tests/unit/sessionsStore.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createSessionsStore } from '../../src/stores/sessions';

describe('sessions store', () => {
  it('loads a project session list', async () => {
    const store = createSessionsStore({ listSessions: vi.fn(async () => [{ path: '/r/a.jsonl', id: 'a', name: 'n', updatedAtMs: 1, preview: 'p', turnCount: 2 }]), readSession: vi.fn() } as never);
    await store.load({ path: '/home/kai', name: 'kai' });
    expect(store.sessions).toHaveLength(1);
    expect(store.state).toBe('ready');
  });

  it('opens a session into turns', async () => {
    const store = createSessionsStore({ listSessions: vi.fn(), readSession: vi.fn(async () => ({ version: 3, id: 'a', cwd: '/home/kai', name: null, turns: [{ role: 'user', text: 'hi', timestampMs: 1 }] })) } as never);
    await store.openSession('/r/a.jsonl');
    expect(store.open?.turns).toHaveLength(1);
  });

  it('reports error instead of an empty list when the read fails', async () => {
    const store = createSessionsStore({ listSessions: vi.fn(async () => { throw new Error('sftp failed'); }), readSession: vi.fn() } as never);
    await store.load({ path: '/home/kai', name: 'kai' });
    expect(store.state).toBe('error');
    expect(store.error).toContain('sftp failed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/sessionsStore.test.ts tests/unit/chatMarkdown.test.ts`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Implement**

Add `dompurify` (and `@types/dompurify` if the package is not self-typed) to
`dependencies`; this is the one sanctioned new dependency (spec §8.6). In
`src/chat/markdown.ts`, configure `marked` with raw HTML disabled (override the
renderer's `html` token to emit nothing) and pass the result through
`DOMPurify.sanitize` with an explicit allow-list; links render as text or are
opened only on an explicit tap (Review Focus 5). Then `sessions.ts`
(dependencies injected as with the other stores) and the three views:
`SessionList.vue` (title from `name` else `id` per R11.4, preview from
`sessionPreview`, relative time, `+` to start a conversation — stubbed until
Plan 3), `ChatScreen.vue` (scrolling bubble list, timestamps as subtle
separators, pull-to-refresh re-reads), `ChatBubble.vue` (self right/green, other
left/white, `--font-mono` for code). The composer bar is present but disabled
with "sending arrives in the next plan" — Plan 3 enables it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/sessionsStore.test.ts tests/unit/chatMarkdown.test.ts`
Expected: PASS (the 7 plan tests plus the R11 additions: `closeChat`,
`refresh` re-reading the open session, `refresh` no-op without a project, the
`load` re-entrancy guard, and an `openSession` failure keeping the previous
chat). Still exactly one top-level `describe` per file.

- [ ] **Step 5: Commit**

```bash
git add src/stores/sessions.ts src/components/sessions src/chat/markdown.ts tests/unit/sessionsStore.test.ts tests/unit/chatMarkdown.test.ts package.json pnpm-lock.yaml
git commit -m "feat(sessions): project session list and a sanitized read-only chat"
```

---

### Task 9: Terminal as a secondary screen

**Files:**
- Create: `src/session/terminalPty.ts`
- Create: `src/components/terminal/TerminalScreen.vue`
- Test: `tests/unit/terminalScreenWiring.test.ts`

**Interfaces:**
- Consumes: `TerminalViewport.vue` (retained, `src/components/TerminalViewport.vue`)
  and the new `terminalPty` seam (created by this task; the shell installs its
  implementation in Task 5). The core attach path (`ConnectionController`'s
  `buildAttachCommand` from `hostCliSessions`) is consumed by the Task 5
  implementation, not by this screen.
- Produces:
  - `src/session/terminalPty.ts`: the `TerminalPty` interface plus
    `installTerminalPty`/`terminalPty` (house seam pattern, like
    `connectionPort.ts`/`piLive.ts`).
  - `src/components/terminal/TerminalScreen.vue`: a route-less overlay (D5),
    opened by 打开终端 from a project or session (the opener is Task 5).
- **Deviations from this plan's earlier text (ruling R12):**
  1. Scope/ordering: R1 runs Task 9 before Task 5, and Task 5 is what creates
     `src/phone/PhoneApp.vue` (`src/phone/` does not exist on disk — verified).
     This task therefore does **not** touch `PhoneApp.vue`. The overlay
     integration — PhoneApp owns the overlay state, the 打开终端 trigger from
     the project/session header, and `installTerminalPty` implemented against
     the shell's `ConnectionController` (attach by name = `listSessions()`
     lookup + `attachSession(row)`, the data pump to `onData`, PTY writes,
     resize, `detach` on close) — is carried to Task 5 and must be in Task 5's
     preflight.
  2. Seam contract (`src/session/terminalPty.ts`), reusing `TerminalGeometry`
     from `src/terminalGeometry.ts`:
     ```ts
     export interface TerminalPty {
       /** Open the PTY attached to the named aplexer session (core `buildAttachCommand`). */
       attach(sessionName: string, geometry: TerminalGeometry): Promise<{ ok: boolean; error?: string }>;
       /** Stream PTY output as decoded text chunks; `detach()` stops the stream. */
       onData(callback: (data: string) => void): void;
       write(data: string): Promise<void>;
       resize(cols: number, rows: number): Promise<void>;
       /** Close the PTY and stop the pump. Idempotent. */
       detach(): Promise<void>;
     }
     export function installTerminalPty(pty: TerminalPty | null): void;
     /** Throws when no shell has installed an implementation. */
     export function terminalPty(): TerminalPty;
     ```
     The screen resolves the seam lazily at attach time and treats an
     uninstalled seam as an error state (「请先连接」-style), never a throw —
     the same house style as Task 7's uninstalled `piLive`.
  3. Name-agnostic screen: props are `sessionName: string` (the aplexer
     session name to attach to) and `title?: string` (display title, defaults
     to `sessionName`); it emits `close`. The Pi project/session → aplexer
     session name mapping happens in the opener (Task 5); v1 = the project
     path's basename (spec §8.7 "for that workspace" — aplexer's naming
     convention is not verifiable from the build box, so this is flagged for
     dogfood sign-off).
  4. Screen wiring:
     - No direct `@xterm/xterm` import — `TerminalViewport`
       (`../TerminalViewport.vue`) is the only xterm owner.
     - On mount: `fit()` the viewport; the initial attach geometry is the last
       viewport `resize` emit, falling back to `{ cols: 80, rows: 24 }` when
       the first emit has not landed. Then `attach(sessionName, geometry)`;
       on success the viewport is `enabled` and focused.
     - Viewport `input` → `pty.write(data)`; viewport `resize` →
       `pty.resize(cols, rows)` (only after a successful attach). PTY output
       lands in the viewport's exposed `write`.
     - Attach failure → error panel (the session name plus the returned
       `error`) with 重试 / 关闭 actions (48px targets).
     - 关闭 (header) and `onBeforeUnmount` both `detach()` so the PTY is
       released (the plan's "close it on leave"); the detach is guarded so
       close-then-unmount cannot double-detach.
     - Phone tokens only (the token gate scans `src/components/**/*.vue`, so
       this file is in scope), Chinese labels, 48px touch targets.
  5. Test: the two plan assertions stand; add one pinning the seam import:
     the SFC must reference `terminalPty` and must not reference
     `ConnectionController` (the screen drives the PTY through the seam only).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/terminalScreenWiring.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('terminal screen', () => {
  it('reuses TerminalViewport rather than a new emulator', () => {
    const sfc = read('../../src/components/terminal/TerminalScreen.vue');
    expect(sfc).toContain('TerminalViewport');
    expect(sfc).not.toContain('@xterm/xterm');
  });
  it('attaches through the core host-CLI session command', () => {
    expect(read('../../src/components/terminal/TerminalScreen.vue')).toContain('attach');
  });
  it('drives the PTY through the shell-owned seam, not a controller', () => {
    const sfc = read('../../src/components/terminal/TerminalScreen.vue');
    expect(sfc).toContain('terminalPty');
    expect(sfc).not.toContain('ConnectionController');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/terminalScreenWiring.test.ts`
Expected: FAIL — the file does not exist.

- [ ] **Step 3: Implement**

Create the `src/session/terminalPty.ts` seam (R12.2) with no implementation.
Build `TerminalScreen.vue` around the retained `TerminalViewport.vue`
(`../TerminalViewport.vue`), driving the PTY only through the seam (R12.4):
attach on mount with the viewport's measured geometry, forward `input`/
`resize`, write the data pump into the viewport's exposed `write`, an error
state for an uninstalled seam and for attach failure (Chinese labels, 48px
actions), and `detach()` on close/unmount so the PTY is released. The overlay
opening (打开终端 from a project or session, D5) and the seam's real
implementation are Task 5's — the screen takes `sessionName`/`title` props and
emits `close`.

- [ ] **Step 4: Run the test and the typecheck**

Run: `pnpm exec vitest run tests/unit/terminalScreenWiring.test.ts`
Expected: PASS (3 tests).
Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/session/terminalPty.ts src/components/terminal/TerminalScreen.vue tests/unit/terminalScreenWiring.test.ts
git commit -m "feat(terminal): retain the terminal as a secondary screen"
```

---

### Task 10a: Reconcile the unit-test gate (no deletions)

**Files:** Modify `scripts/js-unit-test-manifest.json` only.

> **Ruling R14 (preflight) — Task 10 is split.**
>
> **R14.1 — Why.** The original Task 10 delete list names files that are LIVE and
> misses files that must move with them; executing it as written breaks
> `vue-tsc` (see R14.2). Reconciling the gate is a smaller, safe job that
> unblocks the required check by itself, so it runs first and deletes nothing.
>
> **R14.2 — The corrected delete set (settled by the Task 10 import-graph
> inventory; use it for Task 10b).**
> - **Deletable (unreachable from `src/main.ts`'s live closure and unused by
>   surviving dev-mode/scripts/fixtures):** `src/sharedApp/**`, `src/App.vue`,
>   `src/legacyMain.ts`, `src/shellSelection.ts`,
>   `src/platform/android/{androidApi,connectionHub,sync}.ts`,
>   `src/native/{documentContent,googleSync,gatewayPairing,speechRecognition,vaultNative}.ts`,
>   `src/vault/*`, `src/sync/androidSync.ts` (**NOT** `syncCrypto.ts`),
>   `src/session/{dictationController,dictationNoSpeech,inlineDictation,documentTransfers,files}.ts`,
>   `src/stores/{hostSnippets,composerDrafts}.ts`, the 19 non-live
>   `src/components/*` files (spec §6.3),
>   `src/platform/android/gatewayTarget.ts`.
> - **NOT deletable — LIVE, the plan was wrong:** all of `src/migration/*`
>   (`platform/android/hostStore.ts:16`, `hosts.ts:9-10`,
>   `platform/androidDiagnostics.ts:10`), `src/stores/appSettings.ts`
>   (`migration/installedDataMigration.ts:4`), `src/diagnostics.ts`
>   (`native/durableStorage.ts:2`), `src/sync/syncCrypto.ts`
>   (`src/dev/browser/googleSyncPlugin.ts` — browser dev mode, which the Task 5
>   smoke needs — and `scripts/vault-journey-fixture/entry.ts`).
> - **Companions that must move WITH the set** (they import delete targets;
>   keeping them breaks typecheck): `src/session/platformInput.ts`,
>   `src/sync/androidSync.ts`, `src/platform/android/gatewayTarget.ts`.
> - **Survivor tests that hard-code deleted paths and must be edited:**
>   `tests/unit/designTokens.test.ts:77`, `tests/unit/sharedControllersSource.test.ts:51`,
>   `tests/unit/releaseChrome.test.ts:24` (+ its `App.vue` reads); retire
>   `tests/scripts/js-first-rewrite-hotkeys-gate-test.sh` (wired at
>   `.github/workflows/js-first-rewrite.yml:146` and `js-full-suite.yml:153`).
> - **Out of scope here:** `src/destinationInventory.ts` is a stale 0.5.x→shared-app
>   route map (`newRoute: 'settings'/'usage'/'ports'/'files'/'keys'`) for routes the
>   phone shell does not have; its disposition belongs to Plan 5.
> - Task 5 review nits folded in: drop the now-unused `DevToolbarApi.seedHosts`
>   field + its `install.ts` pass-through; fix `docs/browser-dev-mode.md`'s
>   "no session-list screen yet" wording (`SessionList.vue` does render, empty
>   without project discovery).
>
> **R14.3 — Why the gate is red today.** `scripts/run-js-unit-gate.sh` runs the
> whole configured Vitest suite and `scripts/check-js-unit-results.py` enforces
> **exact set equality** between the report and the manifest ("unexpected files");
> 15 on-disk tests are unregistered (all of Plan 1's and Plan 2's new tests), so
> the gate has been red since Plan 1. Task 10a fixes exactly that.
>
> **R14.4 — Registration is the trigger, so titles must be exact.** The checker
> also enforces per-file title-set and count equality, and rejects skipped or
> failing tests. Register the real `it()` titles (take them from a vitest JSON
> report, do not hand-type), and collapse any file with several top-level
> `describe`s under one, or the schema must be widened (collapsing is smaller).

- [ ] **Step 1: Register every on-disk test the manifest is missing**

The 15 unregistered survivors are Plan 1's (`piParseSession`, `piSessionRoot`,
`piCommands`, `piRepository`) and Plan 2's (`hostStoreAuth`, `piResolveSessionRoot`,
`piTransport`, `phoneTokens`, `phoneShellSingleEntry`, `connectionsStore`,
`projectsStore`, `sessionsStore`, `chatMarkdown`, `terminalScreenWiring`,
`terminalUtf8`). Add each as `testFiles["tests/unit/<name>.test.ts"] = { suite,
tests: [<exact it() titles>] }`, matching the existing entry shape. Delete nothing:
the manifest still has no entry for a file that exists.

- [ ] **Step 2: Verify with a real local gate run**

```bash
npx vitest run --reporter=json --outputFile.json=build/test-results/js-unit/vitest-results.json
python scripts/check-js-unit-results.py --report build/test-results/js-unit/vitest-results.json
```

Expected: the checker's errors contain **no "unexpected file"** complaint; its only
remaining complaint may be the two known pre-existing red files
(`devBrowserServer`, `sshKeySetup`), which are not this task's to fix. If a newly
registered test fails or is skipped, stop and report it — do not delete the test
to make the gate pass.

- [ ] **Step 3: Commit**

```bash
git add scripts/js-unit-test-manifest.json
git commit -m "test(gate): register the plan 1 and plan 2 unit tests"
```

---

### Task 10b: Delete the unused screens

**Files (R14.2):**
- Delete the deletable set + the companions above, plus every `tests/unit/*.test.ts`
  that imports one of them (39 of the manifest's 72 entries become invalid).
- Edit `tests/unit/designTokens.test.ts`, `tests/unit/sharedControllersSource.test.ts`,
  `tests/unit/releaseChrome.test.ts`; retire `tests/scripts/js-first-rewrite-hotkeys-gate-test.sh`.
- Modify `scripts/js-unit-test-manifest.json` (remove the entries whose file is gone).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/shellCleanup.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const gone = ['src/sharedApp', 'src/shellSelection.ts', 'src/legacyMain.ts',
  'src/platform/android/androidApi.ts', 'src/platform/android/connectionHub.ts',
  'src/vault', 'src/sync', 'src/migration',
  'src/components/MobileHotkeys.vue', 'src/components/FileWorkspaceScreen.vue'];
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('shell cleanup', () => {
  it('removed every module the new shell does not use', () => {
    for (const p of gone) expect(existsSync(new URL(`../../${p}`, import.meta.url)), p).toBe(false);
  });
  it('the unit gate manifest names no deleted test file', () => {
    const manifest = JSON.parse(read('../../scripts/js-unit-test-manifest.json'));
    for (const file of Object.keys(manifest.testFiles)) {
      expect(existsSync(new URL(`../../${file}`, import.meta.url)), file).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/shellCleanup.test.ts`
Expected: FAIL — the modules still exist and the manifest still names their tests.

- [ ] **Step 3: Delete, then reconcile**

Delete the modules and their dependent tests together. Then reconcile
`scripts/js-unit-test-manifest.json`: remove every entry whose file is gone, and
add entries for the new tests. **The manifest's schema allows exactly one
top-level `describe` per file** and `scripts/check-js-unit-results.py` fails
closed on unexpected files — so any new test file with several top-level
`describe`s must be collapsed under one wrapper `describe`, or the manifest
schema widened. Collapsing is the smaller change. Also retire the source-
assertion scripts that hard-code deleted files
(`tests/scripts/js-first-rewrite-hotkeys-gate-test.sh`) and rewrite
`tests/unit/{destinationInventory,releaseChrome}.test.ts` to the surviving file
list. Verify with `python scripts/check-js-unit-results.py --self-test`.

- [ ] **Step 4: Run the whole suite and the gate**

Run: `pnpm test:unit`
Expected: the surviving tests pass; none reference a deleted module.
Run: `python scripts/check-js-unit-results.py --report build/test-results/js-unit/vitest-results.json`
Expected: exit 0 — manifest and results agree.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(cleanup): delete the unused screens and reconcile the unit gate"
```

---

## Self-Review

- **Spec coverage:** §6.1/§6.3 → Tasks 5, 10; §6.4 layout → Tasks 4, 6–9; §7.1 →
  Task 1; §8.1 → Task 4; §8.2/§8.3 → Task 6; §8.4 + §9.1 discovery → Tasks 2, 7;
  §8.5 + §9.2 → Task 8; §8.6 → Task 8; §8.7 → Task 9; §10 → Task 4. §7.2, §9.4
  are Plan 4 and Plan 3 respectively.
- **Review Focus:** RF1 → Task 1's key-host load and password-refusal tests;
  RF2/RF3 → Task 2 and the
  Task 7 `no-root` test; RF4 → Task 7 error test; RF5 → Task 8 sanitizer test
  plus Task 4's "no raw hex" assertion.
- **Interface consistency:** `SavedHostV2`/`HostAuth` (Task 1) are what Task 6
  persists; `PiTransport` (Plan 1) is implemented in Task 3 and consumed in
  Tasks 7–8; `PiProject`/`PiSessionMeta`/`ParsedPiSession` keep Plan 1's names,
  with `turnCount` (not the spec's `messageCount`).
- **New dependency:** exactly one, `dompurify`, in Task 8 — called out in Step 3.
- **Not verifiable here:** Tasks 6–9 have no device acceptance (Plan 5 owns the
  emulator); their logic is covered by the store tests, and the visual step is
  checked in the Vite dev server (`pnpm dev`) first.

## Follow-on plans

3. `2026-10-19-chat-send-pty-turn.md` — enable the composer: `PiTurnRunner`.
4. `2026-10-19-native-credentials.md` — password auth + remembered key
   passphrase (Java) and the editor fields that use them.
5. `2026-10-19-cleanup-android-acceptance.md` — Android toolchain, packaged-APK
   emulator acceptance, and the fork's gate posture.
