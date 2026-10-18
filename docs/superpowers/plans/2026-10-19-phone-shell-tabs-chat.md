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

1. A **v1 host record with a `keyHandleId`** must migrate to a v2
   `{kind:'key'}` record without losing the field, and a record already in v2
   shape must be left alone (idempotent re-run).
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

### Task 1: Saved-host store v2 with a v1→v2 migration

**Files:**
- Modify: `src/platform/android/hostStore.ts`
- Test: `tests/unit/hostStoreV2.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type HostAuth = { kind: 'key'; keyHandleId: string; rememberPassphrase: boolean } | { kind: 'password'; passwordCredentialId: string }`
  - `interface SavedHostV2 { name: string; hostname: string; port: number; user: string; auth: HostAuth; piSessionsDir?: string; piCommand?: string }`
  - `const ANDROID_HOSTS_STORAGE_KEY_V2 = 'pocketshell.android.hosts.v2'`
  - `function migrateHostsV1(v1: unknown): SavedHostV2[]`
  - `function readHosts(storage: StringStorage): SavedHostV2[]`
  - `function writeHosts(storage: StringStorage, hosts: SavedHostV2[]): void`
  - `validateSavedHost` extended to the v2 shape.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/hostStoreV2.test.ts
import { describe, expect, it } from 'vitest';
import { migrateHostsV1, readHosts, writeHosts } from '../../src/platform/android/hostStore';

const v1 = JSON.stringify([
  { name: 'kai', hostname: '192.168.1.3', port: 22, user: 'kai', keyHandleId: 'h-1' },
]);

describe('hostStore v2', () => {
  it('migrates a v1 key-only record to an auth.key record', () => {
    expect(migrateHostsV1(JSON.parse(v1))).toEqual([
      { name: 'kai', hostname: '192.168.1.3', port: 22, user: 'kai',
        auth: { kind: 'key', keyHandleId: 'h-1', rememberPassphrase: false } },
    ]);
  });

  it('is idempotent on an already-v2 record', () => {
    const once = migrateHostsV1(JSON.parse(v1));
    expect(migrateHostsV1(once)).toEqual(once);
  });

  it('drops a v1 record with no key handle and keeps the rest', () => {
    const mixed = [...JSON.parse(v1), { name: 'x', hostname: 'h', port: 22, user: 'u' }];
    expect(migrateHostsV1(mixed).map((h) => h.name)).toEqual(['kai']);
  });

  it('returns [] for absent or garbage input', () => {
    expect(migrateHostsV1(undefined)).toEqual([]);
    expect(migrateHostsV1('nonsense')).toEqual([]);
  });

  it('reads v2 first and falls back to migrating v1', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    store.set('pocketshell.android.hosts.v1', v1);
    expect(readHosts(storage).map((h) => h.name)).toEqual(['kai']);
    writeHosts(storage, [{ name: 'p', hostname: 'h', port: 22, user: 'u',
      auth: { kind: 'password', passwordCredentialId: 'c-1' } }]);
    expect(readHosts(storage)).toHaveLength(1);
    expect(readHosts(storage)[0].auth).toEqual({ kind: 'password', passwordCredentialId: 'c-1' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/hostStoreV2.test.ts`
Expected: FAIL — the named exports do not exist.

- [ ] **Step 3: Implement**

Add `HostAuth`/`SavedHostV2` and the four functions to `hostStore.ts`.
`migrateHostsV1` accepts `unknown`: non-array → `[]`; per entry, if it already
has a valid `auth` keep it verbatim, else if it has a non-empty `keyHandleId`
produce `{kind:'key', keyHandleId, rememberPassphrase:false}`, else drop it.
`readHosts` reads the v2 key; if absent, migrates v1 and **writes the result
back**. Secret material never lands in `localStorage` — only handles/ids
(spec §7.1, D2). Keep `validateSavedHost` exported and extend it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/hostStoreV2.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/android/hostStore.ts tests/unit/hostStoreV2.test.ts
git commit -m "feat(hosts): saved-host v2 with auth union and a v1 migration"
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
- Consumes: `PiTransport` (Plan 1), core `SshCapability`/`ConnectionController`.
- Produces:
  - `interface PiExecTarget { exec(command: string, options: { timeoutMs: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null }> }`
  - `interface PiSftpReader { sftpRead(options: { path: string; maxBytes: number }): Promise<{ dataBase64: string }> }`
  - `function createPiTransport(exec: PiExecTarget, sftp: PiSftpReader): PiTransport`
  - `function decodeBase64Utf8(dataBase64: string): string`

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

### Task 5: Collapse the two shells into one

**Files:**
- Create: `src/phone/PhoneApp.vue`
- Modify: `src/main.ts`, `capacitor.config.ts`, `android/app/src/main/java/com/pocketshell/app/MainActivity.java`
- Delete: `src/sharedApp/**`, `src/shellSelection.ts`, `src/platform/android/androidApi.ts`, `src/platform/android/connectionHub.ts`

**Interfaces:**
- Consumes: `AppTabBar.vue` (Task 4), the stores from Tasks 6–8.
- Produces: one root mounted by `src/main.ts`; `PhoneApp.vue` owns the active
  tab and lays out the tab bar above the active tab's view.

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
  it('the two removed shells are gone from disk', () => {
    expect(() => read('../../src/sharedApp/main.ts')).toThrow();
    expect(() => read('../../src/platform/android/androidApi.ts')).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/phoneShellSingleEntry.test.ts`
Expected: FAIL — `main.ts` still branches on `selectShell`.

- [ ] **Step 3: Implement the collapse**

Delete the two shared-shell trees and `shellSelection.ts`. Rewrite `src/main.ts`
to `bridgeWarmUp()` → `installAndroidDurableStorage()` → `createApp(PhoneApp)`
with `createPinia()` and the existing platform-services install (keep
`applySharedUiDefaults` and the `@ui/styles.css` + `xterm.css` + `./styles.css`
imports). Remove the `server.appStartPath` shell query from
`capacitor.config.ts`. In `MainActivity.java` drop the `EXTRA_SHELL` constants
and the start-path override so the WebView loads `/`. Keep `installAndroidPlatformServices`
minus the parts that only served `androidApi`.

- [ ] **Step 4: Run the test and the typecheck**

Run: `pnpm exec vitest run tests/unit/phoneShellSingleEntry.test.ts`
Expected: PASS (3 tests).
Run: `pnpm typecheck`
Expected: exit 0 — every dangling import of a deleted module is resolved by the
deletions in Tasks 5–9; do not paper over a failure by re-adding a module.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(shell): one phone shell, shared-shell path removed"
```

---

### Task 6: Connections tab — list and editor (key auth)

**Files:**
- Create: `src/stores/connections.ts`
- Create: `src/components/connections/ConnectionsList.vue`
- Create: `src/components/connections/ConnectionEditor.vue`
- Test: `tests/unit/connectionsStore.test.ts`

**Interfaces:**
- Consumes: `readHosts`/`writeHosts`, `SavedHostV2`/`HostAuth` (Task 1),
  `ConnectionController`, `hostKeyCard`, `hostStore`.
- Produces:
  - `useConnectionsStore()` with state `{ hosts: SavedHostV2[]; activeName: string | null; status: 'idle' | 'connecting' | 'connected' | 'error'; lastError: string | null }` and actions `load()`, `save(host)`, `remove(name)`, `connect(name)`, `disconnect()`.
  - `statusFor(name): 'connected' | 'idle'` — only `activeName` can be `connected` (D8).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/connectionsStore.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createConnectionsStore } from '../../src/stores/connections';

const host = { name: 'kai', hostname: '192.168.1.3', port: 22, user: 'kai', keyHandleId: 'h-1' };

describe('connections store', () => {
  it('migrates the legacy list on load', async () => {
    const store = createConnectionsStore({ readHosts: () => [{ name: 'kai', hostname: 'h', port: 22, user: 'u', auth: { kind: 'key', keyHandleId: 'h-1', rememberPassphrase: false } }], writeHosts: vi.fn(), controller: { connect: vi.fn(), disconnect: vi.fn() } });
    await store.load();
    expect(store.hosts).toHaveLength(1);
    expect(store.statusFor('kai')).toBe('idle');
  });

  it('only the active host can report connected', async () => {
    const controller = { connect: vi.fn(async () => ({ ok: true })), disconnect: vi.fn(async () => {}) };
    const store = createConnectionsStore({ readHosts: () => [], writeHosts: vi.fn(), controller: controller as never });
    await store.connect('a');
    expect(store.statusFor('a')).toBe('connected');
    expect(store.statusFor('b')).toBe('idle');
  });

  it('closes the current connection before opening another', async () => {
    const controller = { connect: vi.fn(async () => ({ ok: true })), disconnect: vi.fn(async () => {}) };
    const store = createConnectionsStore({ readHosts: () => [], writeHosts: vi.fn(), controller: controller as never });
    await store.connect('a'); await store.connect('b');
    expect(controller.disconnect).toHaveBeenCalledTimes(1);
  });

  it('surfaces a dial failure as status error, not a throw', async () => {
    const controller = { connect: vi.fn(async () => { throw new Error('auth failed'); }), disconnect: vi.fn() };
    const store = createConnectionsStore({ readHosts: () => [], writeHosts: vi.fn(), controller: controller as never });
    await store.connect('a');
    expect(store.status).toBe('error');
    expect(store.lastError).toContain('auth failed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/connectionsStore.test.ts`
Expected: FAIL — cannot resolve `../../src/stores/connections`.

- [ ] **Step 3: Implement the store, then the two views**

`createConnectionsStore(deps)` takes its dependencies (`readHosts`, `writeHosts`,
`controller`) as arguments so it is testable without Pinia or a device; export a
`useConnectionsStore()` wrapper that binds the real ones. `connect` disconnects
any current host first and never throws — it records `status: 'error'` and
`lastError`. Then build the list (green/red dot, name, `host · user`, key glyph
from `KeyIcon.vue`, `…` for edit/delete, `+` in the app bar, empty state with a
big 新增连接 button) and the editor (name, host, port, user, auth method; key
picker from the vault; **Pi sessions directory** and **pi command** fields per
spec §9.1). On connect with an unknown host key, drive core's
`HostKeyTrustPrompt.vue` through `hostKeyCard.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/connectionsStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stores/connections.ts src/components/connections tests/unit/connectionsStore.test.ts
git commit -m "feat(connections): saved-host list and editor backed by a store"
```

---

### Task 7: Projects tab — discovery, search, refresh, add

**Files:**
- Create: `src/stores/projects.ts`
- Create: `src/components/projects/ProjectsList.vue`
- Test: `tests/unit/projectsStore.test.ts`

**Interfaces:**
- Consumes: `PiRepository`, `resolveSessionRoot`, `PiTransport` (Tasks 2–3).
- Produces:
  - `useProjectsStore()` with `{ projects: PiProject[]; state: 'idle' | 'loading' | 'ready' | 'no-root' | 'error'; error: string | null; query: string }`, actions `discover()`, `setQuery(q)`, `addProject(path)`, getter `filtered`.
  - `state === 'no-root'` when `resolveSessionRoot` returns `null` (Review Focus 3).

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
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stores/projects.ts src/components/projects tests/unit/projectsStore.test.ts
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
`SessionList.vue` (title from `name` else the first user turn, preview from
`sessionPreview`, relative time, `+` to start a conversation — stubbed until
Plan 3), `ChatScreen.vue` (scrolling bubble list, timestamps as subtle
separators, pull-to-refresh re-reads), `ChatBubble.vue` (self right/green, other
left/white, `--font-mono` for code). The composer bar is present but disabled
with "sending arrives in the next plan" — Plan 3 enables it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/sessionsStore.test.ts tests/unit/chatMarkdown.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stores/sessions.ts src/components/sessions src/chat/markdown.ts tests/unit/sessionsStore.test.ts tests/unit/chatMarkdown.test.ts package.json pnpm-lock.yaml
git commit -m "feat(sessions): project session list and a sanitized read-only chat"
```

---

### Task 9: Terminal as a secondary screen

**Files:**
- Create: `src/components/terminal/TerminalScreen.vue`
- Modify: `src/phone/PhoneApp.vue`

**Interfaces:**
- Consumes: `TerminalViewport.vue`, `ConnectionController`'s attach path
  (`buildAttachCommand` from core `hostCliSessions`).
- Produces: a route-less overlay opened by 打开终端 from a project or session.

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/terminalScreenWiring.test.ts`
Expected: FAIL — the file does not exist.

- [ ] **Step 3: Implement**

Build `TerminalScreen.vue` around the retained `TerminalViewport.vue`, wired to
the live `ConnectionController` the way legacy `App.vue` did (pass a
`writePty`-style effect and consume the PTY stream), attaching via core's
`buildAttachCommand` (`pocketshell sessions attach -- '<name>'`, an aplexer
`a attach`). Open it from a project/session header action; it is an overlay, not
a fourth tab (D5). Close it on leave so its PTY is released.

- [ ] **Step 4: Run the test and the typecheck**

Run: `pnpm exec vitest run tests/unit/terminalScreenWiring.test.ts`
Expected: PASS (2 tests).
Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal/TerminalScreen.vue src/phone/PhoneApp.vue tests/unit/terminalScreenWiring.test.ts
git commit -m "feat(terminal): retain the terminal as a secondary screen"
```

---

### Task 10: Delete the unused screens and reconcile the test gate

**Files:**
- Delete: `src/App.vue` (superseded by `src/phone/PhoneApp.vue`), the 19 unused
  `src/components/*` files listed in spec §6.3, `src/vault/*`, `src/sync/*`,
  `src/platform/android/{sync,googleSync,gatewayPairing}.ts`,
  `src/native/{documentContent,googleSync,gatewayPairing,speechRecognition,vaultNative}.ts`,
  `src/session/{dictation*,inlineDictation,documentTransfers,files}.ts`,
  `src/stores/{hostSnippets,composerDrafts,appSettings}.ts`, `src/migration/*`,
  `src/diagnostics.ts`, plus every `tests/unit/*.test.ts` that imports one of them.
- Modify: `scripts/js-unit-test-manifest.json`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/shellCleanup.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const gone = ['src/sharedApp', 'src/vault', 'src/sync', 'src/migration',
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
- **Review Focus:** RF1 → Task 1 idempotence test; RF2/RF3 → Task 2 and the
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
