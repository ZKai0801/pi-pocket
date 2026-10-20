# PocketShell WeChat-UI Rebuild — Plan 4: Credentials (remembered passphrase + password)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host be configured with key **or** password, and stop asking for a
key's passphrase on every connect. Today the native side already performs
password auth, but nothing persists either a passphrase or a password, so a
passphrase-protected key prompts on every dial (spec §7.1–§7.3).

**Architecture:** A new native `RememberedSecretStore` seals one secret per
`secretId` with an Android-Keystore AES/GCM key — the same pattern the existing
`CredentialHandleVault`/`VaultDeviceKeyStore` already use. `SavedHostV2.auth`
(Task 1 of Plan 2) references a `secretId`, never a secret. Connect builds a core
`SshCredential` from the host record plus the store, in a pure function so the
credential shape is unit-tested without a device.

**Tech Stack:** Java (Capacitor plugin + `androidx.security` Keystore crypto),
Capacitor 8, Vue 3 + Pinia, core `SshCredential`.

**Spec:** `docs/superpowers/specs/2026-10-19-wechat-ui-pi-design.md` (§7.1–§7.3, D2)
**Predecessor:** `docs/superpowers/plans/2026-10-19-phone-shell-tabs-chat.md`

## What is already true (verified — do not rebuild)

- **Password auth works.** `SshCapabilityPlugin.java:360-368` reads
  `credential.password` and calls `client.authPassword(username, secret)`,
  blanking the `char[]` after. `SshCredential` in
  `vendor/pocketshell-core/src/sshCapability.ts:12-15` already has
  `{ kind: 'password'; password: string }`. There is **no** native auth work to do.
- **Keys are already sealed at rest.** `CredentialHandleVault` stores each key
  encrypted (AES/GCM, `AndroidKeyProtector`, Keystore alias
  `pocketshell.ssh.credential-vault.v1`) and exposes only public metadata plus
  `passphraseRequired`. A passphrase is passed *per connect* as a transient
  `char[]` and never written.
- **The gap is persistence only:** a passphrase and a password both die with the
  process (`EphemeralCredentials` is memory-only).

## Global Constraints

- **Never widen `CredentialHandleVault`'s contract.** It is documented as "only
  encrypted key files and public metadata"; add the new store beside it, do not
  store a passphrase inside a key record (spec §7.1, D2).
- **No secret in `localStorage`, no secret in the host record.** `SavedHostV2`
  carries a `secretId`; the plaintext exists only inside the native store and in
  a `char[]`/string for the lifetime of one dial (D2).
- **Fail closed.** A `secretId` that cannot be decrypted (Keystore reset, app
  data cleared) must behave as "no remembered secret": prompt, do not dial with
  an empty secret.
- **Forgetting is explicit.** Deleting a host, switching a host off
  password/remember, and a "forget saved credentials" action must all delete the
  sealed secret; never leave an orphan.
- **No new JS dependency.**
- Reuse the existing Keystore helper rather than a second crypto implementation
  (`AndroidKeyProtector`, and `VaultDeviceKeyStore`'s `EncryptedSyncTokenStore`
  pattern are both precedents).

## Review Focus

1. A `secretId` present in the host record but **absent or undecryptable** in the
   store must resolve to "not remembered" and trigger a prompt — never to an
   empty string handed to the dial path.
2. A key host with `rememberPassphrase: true` must still **not** send a
   passphrase when the secret is absent; the `key-handle` credential's
   `passphrase` stays `null` so sshj produces the passphrase prompt rather than a
   silent auth failure.
3. Switching a host from password back to key (or clearing the remember toggle)
   must delete the now-unreferenced sealed secret on save.
4. The native store must reject a `secretId` from another install/app (it is
   namespaced) and must never log the secret.

---

### R27 — Plan 4 preflight ruling (authoritative, resolved 2026-10-19)
The plan's premises that do not match `main` (`350136a`):
1. **No `SavedHostV2`.** The type is `SavedHost` in
   `src/platform/android/hostStore.ts:25-42`; Plan 2 added the optional
   `auth?: HostAuth` field **in place** and there is still one storage key
   (`pocketshell.android.hosts.v1`). Do **not** add a v2 key or a migration in
   this plan.
2. **`HostAuth` has no remember/secret fields yet.** Extend the key variant to
   `{ kind: 'key'; keyHandleId: string; rememberPassphrase?: boolean; secretId?: string }`
   (spec §7.1's `rememberPassphrase` stays optional so every v1 record — and every
   `{kind:'key', keyHandleId}` written by Plan 2 — remains valid; absence = not
   remembering). Teach `isHostAuth` the two optional fields (boolean / non-empty
   string) and leave `validateSavedHost` semantics unchanged.
3. **`tests/unit/hostStoreV2.test.ts` does not exist.** Extend
   `tests/unit/hostStoreAuth.test.ts` (suite "SavedHost auth", 5 titles today)
   for the added field instead.
4. **`buildSshCredential` calls `lookup` only when the record actually asks for a
   remembered secret**: key → `rememberPassphrase === true` **and** a non-empty
   `secretId`; a stale `secretId` with remember off is **not** looked up (and is
   what Task 4's save-time cleanup deletes).
5. A password credential is resolved from `passwordCredentialId`; a `null` **or
   throwing** lookup is the same actionable hard error (`/password/i`), never a
   dial with an empty secret (Review Focus 1).
6. No pnpm on this box: `npx vitest run <file>`; register every new/edited title
   in `scripts/js-unit-test-manifest.json` from a fresh JSON report (R18.5).

---

### Task 1: `buildSshCredential` — one tested credential shape
**Files:**
- Create: `src/credentials/buildSshCredential.ts`
- Test: `tests/unit/buildSshCredential.test.ts`

**Interfaces:**
- Consumes: `SavedHostV2`/`HostAuth` (Plan 2 Task 1), core `SshCredential`.
- Produces:
  - `type SecretLookup = (secretId: string) => Promise<string | null>`
  - `function buildSshCredential(auth: HostAuth, lookup: SecretLookup): Promise<SshCredential>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/buildSshCredential.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildSshCredential } from '../../src/credentials/buildSshCredential';

describe('buildSshCredential', () => {
  it('returns a bare key-handle when nothing is remembered', async () => {
    const c = await buildSshCredential({ kind: 'key', keyHandleId: 'h-1', rememberPassphrase: false }, vi.fn());
    expect(c).toEqual({ kind: 'key-handle', handleId: 'h-1', passphrase: null });
  });

  it('attaches the remembered passphrase', async () => {
    const lookup = vi.fn(async () => 'hunter2');
    const c = await buildSshCredential({ kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1' }, lookup);
    expect(c).toEqual({ kind: 'key-handle', handleId: 'h-1', passphrase: 'hunter2' });
  });

  it('does not send a passphrase when the remembered secret is gone', async () => {
    const c = await buildSshCredential({ kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1' }, vi.fn(async () => null));
    expect(c).toEqual({ kind: 'key-handle', handleId: 'h-1', passphrase: null });
  });

  it('builds a password credential from the store', async () => {
    const c = await buildSshCredential({ kind: 'password', passwordCredentialId: 's-2' }, vi.fn(async () => 'pw'));
    expect(c).toEqual({ kind: 'password', password: 'pw' });
  });

  it('refuses to build a password credential without a stored password', async () => {
    await expect(buildSshCredential({ kind: 'password', passwordCredentialId: 's-2' }, vi.fn(async () => null)))
      .rejects.toThrow(/password/i);
  });

  it('treats an undecryptable secret as absent', async () => {
    const lookup = vi.fn(async () => { throw new Error('keystore reset'); });
    const c = await buildSshCredential({ kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1' }, lookup);
    expect(c.passphrase).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/buildSshCredential.test.ts`
Expected: FAIL — cannot resolve `../../src/credentials/buildSshCredential`.

- [ ] **Step 3: Implement**

Wrap every `lookup` call in try/catch and treat a throw as `null` (Review Focus
1: a lookup failure is "not remembered", never an exception escaping the dial
path). A key credential's `passphrase` is `null` when there is nothing to send,
so sshj is the one that prompts (Review Focus 2). A password credential with no
stored password is a hard failure with an actionable message. This changes
`HostAuth`'s key variant: add the optional `secretId?: string` to
`{kind:'key', keyHandleId, rememberPassphrase, secretId?}` in
`src/platform/android/hostStore.ts` and cover the added field in
`tests/unit/hostStoreV2.test.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/buildSshCredential.test.ts tests/unit/hostStoreV2.test.ts`
Expected: PASS (6 + 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/credentials/buildSshCredential.ts src/platform/android/hostStore.ts tests/unit/buildSshCredential.test.ts tests/unit/hostStoreV2.test.ts
git commit -m "feat(credentials): build the dial credential from a saved host"
```

---

### Task 2: The native `RememberedSecretStore`

**Files:**
- Create: `android/app/src/main/java/com/pocketshell/app/RememberedSecretStore.java`
- Create: `android/app/src/test/java/com/pocketshell/app/RememberedSecretStoreTest.java`
- Modify: `android/app/src/main/java/com/pocketshell/app/SshKeyVaultPlugin.java`

**Interfaces:**
- Produces (Java): `RememberedSecretStore.forContext(Context)`,
  `synchronized String put(String secretId, char[] secret)`,
  `synchronized char[] resolve(String secretId)`,
  `synchronized boolean delete(String secretId)`.
- Produces (bridge): plugin methods `rememberSecret({kind, secretId?, secret})`
  → `{secretId}`, `resolveSecret({secretId})` → `{secret}`,
  `forgetSecret({secretId})` → `{deleted}`.

- [ ] **Step 1: Write the failing JVM test**

```java
// android/app/src/test/java/com/pocketshell/app/RememberedSecretStoreTest.java
package com.pocketshell.app;

import static org.junit.Assert.*;

import org.junit.Test;

public class RememberedSecretStoreTest {
    @Test public void roundTripsASecret() throws Exception {
        RememberedSecretStore store = RememberedSecretStore.forTesting(new java.io.File(
            System.getProperty("java.io.tmpdir"), "rs-" + java.util.UUID.randomUUID()));
        char[] secret = "hunter2".toCharArray();
        String id = store.put(null, secret);
        assertArrayEquals("hunter2".toCharArray(), store.resolve(id));
    }

    @Test public void deletingMakesItUnresolvable() throws Exception {
        RememberedSecretStore store = RememberedSecretStore.forTesting(new java.io.File(
            System.getProperty("java.io.tmpdir"), "rs-" + java.util.UUID.randomUUID()));
        String id = store.put(null, "x".toCharArray());
        assertTrue(store.delete(id));
        assertNull(store.resolve(id));
    }

    @Test public void anUnknownIdIsNullNotAnException() throws Exception {
        RememberedSecretStore store = RememberedSecretStore.forTesting(new java.io.File(
            System.getProperty("java.io.tmpdir"), "rs-" + java.util.UUID.randomUUID()));
        assertNull(store.resolve("no-such-id"));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `android\gradlew.bat -p android testDebugUnitTest --tests "com.pocketshell.app.RememberedSecretStoreTest"`
Expected: FAIL — `RememberedSecretStore` does not exist.
(If no JDK is installed, this step cannot run; see Plan 5 Task 1 and mark the
task blocked rather than skipping the test.)

- [ ] **Step 3: Implement the store and the bridge methods**

Mirror `CredentialHandleVault`'s structure: a `PREFERENCES_NAME` (new, e.g.
`pocketshell_remembered_secrets_v1`), an `EncryptedSyncTokenStore`-style
encrypt/decrypt through the Keystore helper, a UUID `secretId` when none is
supplied, and a `delete`. Method names: `resolve` never throws for an unknown or
undecryptable id — it returns `null` (Review Focus 1). `put` clones the incoming
`char[]` and blanks the caller's copy the way
`CredentialHandleVault.importBytes` does. Register the three bridge methods on
`SshKeyVaultPlugin` with `@PluginMethod`, returning an error for a malformed
`secretId` and never echoing a secret in a log or an error message (Review Focus
4).

- [ ] **Step 4: Run the test to verify it passes**

Run: `android\gradlew.bat -p android testDebugUnitTest --tests "com.pocketshell.app.RememberedSecretStoreTest"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/pocketshell/app/RememberedSecretStore.java android/app/src/test/java/com/pocketshell/app/RememberedSecretStoreTest.java android/app/src/main/java/com/pocketshell/app/SshKeyVaultPlugin.java
git commit -m "feat(native): a Keystore-sealed store for remembered credentials"
```

---

### R28 — Task 2 fix round and the Task 3 contract (authoritative, resolved 2026-10-19)
Static review of Task 2 (no JDK on this box, so nothing compiled) found no Blocker
but two IMPORTANTs and several minors:
1. **The JVM test never runs the two Review Focus 1 failure modes.** `forTesting`
   hard-wires the identity protector, so an *undecryptable* record is only
   inspected, never exercised, and no test injects a failing write. Add seams:
   `forTesting(File)` delegates to `forTesting(File, KeyProtector)` and
   `forTesting(File, SecretRepository, KeyProtector)`; test (a) a protector whose
   `open` throws → `resolve` returns `null`; (b) a repository whose `write` throws
   → `put` throws `IOException` and leaves no record; (c) `put("not-a-uuid", …)` →
   `IOException` **and** the caller's array is wiped; (d) a traversal-shaped id
   (`../../x`) is refused.
2. **A failed `delete` reads as "already gone".** Change the signature to
   `synchronized boolean delete(String secretId) throws IOException`: a failed
   commit must surface (Global Constraint: never leave an orphan), while a
   malformed id still returns `false` without touching storage. `forgetSecret`'s
   reject path becomes reachable; test it with the failing repository.
3. Cache **one store per plugin instance** (lazy, synchronized) instead of
   `forContext` per bridge call — otherwise the store's `synchronized` is
   per-instance and every call reopens EncryptedSharedPreferences/Keystore.
4. **Task 3 contract (amends the Task 3 text below):** the JS wrapper's `put`
   takes an explicit kind —
   `put(secret: string, kind: 'key-passphrase' | 'password', secretId?: string): Promise<string>`
   — because `rememberSecret` validates and requires it. The wrapper's
   `RememberedSecrets` interface therefore has three arguments, not two.
Deferred: extracting one alias-parameterized Keystore protector shared with
`CredentialHandleVault` (a later cleanup, not this plan); real at-rest proof, the
Keystore alias, app-data wipe and the bridge round-trip stay Plan 5 device checks.

---

### Task 3: The JS wrapper
**Files:**
- Create: `src/native/rememberedSecrets.ts`
- Test: `tests/unit/rememberedSecrets.test.ts`

**Interfaces:**
- Consumes: `SshKeyVaultPlugin` registration (Task 2).
- Produces:
  - `type RememberedSecretKind = 'key-passphrase' | 'password'`
- `interface RememberedSecrets { put(secret: string, kind: RememberedSecretKind, secretId?: string): Promise<string>; resolve(secretId: string): Promise<string | null>; forget(secretId: string): Promise<void> }`
  - `function createRememberedSecrets(plugin: NativeRememberedSecretsPlugin): RememberedSecrets`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/rememberedSecrets.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createRememberedSecrets } from '../../src/native/rememberedSecrets';

describe('rememberedSecrets', () => {
  it('returns the id the native store handed back', async () => {
    const store = createRememberedSecrets({ rememberSecret: vi.fn(async () => ({ secretId: 's-1' })), resolveSecret: vi.fn(), forgetSecret: vi.fn() } as never);
    expect(await store.put('pw', 'password')).toBe('s-1');
  });

  it('rejects a reply that is not a UUID-shaped id', async () => {
    const store = createRememberedSecrets({ rememberSecret: vi.fn(async () => ({ secretId: 'nope' })), resolveSecret: vi.fn(), forgetSecret: vi.fn() } as never);
    await expect(store.put('pw', 'password')).rejects.toThrow();
  });

  it('resolves null for a missing secret instead of throwing', async () => {
    const store = createRememberedSecrets({ rememberSecret: vi.fn(), resolveSecret: vi.fn(async () => { throw new Error('unknown'); }), forgetSecret: vi.fn() } as never);
    expect(await store.resolve('s-1')).toBeNull();
  });

  it('returns a resolved secret verbatim', async () => {
    const store = createRememberedSecrets({ rememberSecret: vi.fn(), resolveSecret: vi.fn(async () => ({ secret: 'pw' })), forgetSecret: vi.fn() } as never);
    expect(await store.resolve('s-1')).toBe('pw');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/rememberedSecrets.test.ts`
Expected: FAIL — cannot resolve `../../src/native/rememberedSecrets`.

- [ ] **Step 3: Implement**

Validate the returned `secretId` against the same UUID shape
`isSshKeyMetadata` uses (`/^[0-9a-f-]{36}$/i`) and throw on anything else —
a bad id would silently orphan a secret. `resolve` catches and returns `null`
(Review Focus 1). Register the plugin under the existing `SshKeyVault` name so no
new native registration is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/rememberedSecrets.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/native/rememberedSecrets.ts tests/unit/rememberedSecrets.test.ts
git commit -m "feat(native): typed wrapper over the remembered-secret store"
```

---

### R29 — Task 4 preflight, split into 4a (store) and 4b (editor) (authoritative, resolved 2026-10-19)
The plan's Task 4 test skeleton does not match `main` (`60cdad2`):
1. **Dep shape.** `createConnectionsStore` takes `{ hosts: ConnectionsHosts, port: ConnectionPort }`
   (`src/stores/connections.ts:69-72`); there is no `readHosts`/`writeHosts`/`controller`.
   Add **optional** `secrets?: RememberedSecrets` (default: `resolve → null`,
   `forget → no-op`, `put → throws`) so every existing store test keeps
   constructing the same deps; the Pinia wrapper always binds the real
   `rememberedSecrets` singleton.
2. **Where the credential enters.** `port.connect(target: SshHostTarget)` already
   carries `credential`, and `androidHosts.resolve()` builds it
   (`src/platform/android/hostStore.ts:194-228`) — today it refuses a password
   host outright (`:205-209`). Give `resolve` an **optional second argument**
   `credential?: SshCredential`; when present it is used verbatim and the
   password refusal is skipped (a key host with no handle still throws
   `MissingHostCredential`). `connect()` builds it first:
   `buildSshCredential(host.auth ?? { kind: 'key', keyHandleId: host.keyHandleId }, id => secrets.resolve(id))`,
   then `hosts.resolve(request, credential)`.
3. **`save` becomes async** (`Promise<void>`): it must seal a newly typed secret
   and forget an unreferenced one, both async. Callers use `void`/`await`.
   - `save(host, previousName?, secret?)`: when `secret` is non-empty, seal it
     with the kind implied by `host.auth` (`password` → `'password'`; key →
     `'key-passphrase'`) and write the returned id into the record
     (`passwordCredentialId` / `secretId`). When the incoming record no longer
     references an old id (remember off, auth switched, or a replaced id), call
     `secrets.forget(oldId)` **after** the host write; a failing forget must not
     fail the save.
   - `saveSecret(host, secret)`: the plan's public helper (seal + write, no
     rename) so tests and any other caller can use it directly.
   - `remove(name)`: forget the removed record's ids (key `secretId` and
     password `passwordCredentialId`), then delete the host; a failing forget
     never blocks the deletion.
   - `forgetSecrets(name)`: the explicit 清除已保存凭据 action — forget every id
     the record holds and rewrite the record without them.
4. **A remembering key host with no `secretId`** must build `passphrase: null`
   (sshj prompts) — that is Task 1's contract, not a store error. Record in the
   ledger that the phone build has no transient passphrase prompt yet, so such a
   host fails to dial; Plan 5 decides whether to add it. Do not fake it.
5. **No PTY/terminal jargon** in new user copy; Chinese labels; ≥48px targets;
   tokens only; `data-testid` on new controls.
6. **Split:** 4a = store + `hostStore.resolve` + tests
   (`tests/unit/connectionsCredentials.test.ts`, plus the existing
   `connectionsStore`/`connectionsSwitchConfirm`/`connectionsPiDir`/`connectionsRename`
   still green). 4b = `ConnectionEditor.vue` + `ConnectionsList.vue` + a local
   `LockIcon.vue` (no `lock` glyph in core `AppIcon`; follow `KeyIcon.vue`'s
   precedent) + `tests/unit/connectionEditorAuth.test.ts` (jsdom +
   `testTransformMode.web` entry). 4b's editor emits
   `save: [host, secret: string | null]` and `forget-credentials: []`.

---

### R30 — Task 4b contract: where a remembered secret may enter, and how it leaves (authoritative, resolved 2026-10-21)

Written after the 4a review (`e149628`) so 4b cannot guess. These clauses are
**criteria**, not advice: each needs a test.

1. **A secret enters only while remembering is on.** The editor emits a non-empty
   `secret` only when its remember toggle (记住口令 on the key path, 记住密码 on the
   password path) is on **and** the user typed a value. Toggle off ⇒ emit
   `null`. This is forced by the store: `withSealedSecret`
   (`src/stores/connections.ts:127-135`) writes `rememberPassphrase: true` for a
   key host unconditionally, so a secret passed with the toggle off would
   silently resurrect remembering.
2. **`save` is awaited; the editor closes only on success.** `ConnectionsList.saveHost`
   becomes `async` and does `await store.save(host, previousName, secret)`,
   then `closeEditor()`. A rejected save (e.g. `secrets.put` throwing on a broken
   Keystore) keeps the editor open and shows a Chinese error. Required test:
   a rejected save ⇒ the editor is still mounted and the error is rendered, and
   `closeEditor` was not reached.
3. **Clearing a saved password is an explicit forget, not an omission.**
   `HostAuth`'s password variant has no remember flag and `withoutUnusedSecretId`
   (`:120-125`) only strips the **key** branch, so "记住密码 off" on a host that
   already holds a `passwordCredentialId` cannot be expressed by `save` alone —
   without this clause the toggle would silently keep the old password. Contract:
   when the stored record holds a password id and the toggle is now off (no new
   password typed), the list calls `store.forgetSecrets(name)` **after** the
   successful save; the resulting record must no longer reference the id.
   Required test: `secrets.forget` called with that id and the written record
   carries `passwordCredentialId: ''`.
4. **An explicit forget action must not fail silently.** `forgetSecrets` is the
   one path that intentionally lets a rejection escape (4a report, "Limits"), so
   the list must `catch` it and show a Chinese error rather than leave an
   unhandled rejection. Required test: a rejecting `forgetSecrets` surfaces a
   message and the row survives.
5. **A rename that fails to write leaves the tree as it found it.** 4a's `save`
   removes the previous record *before* `deps.hosts.save` (`:202-214`), so a
   thrown host write during a rename deletes the old record and cannot forget its
   secret. Out of 4b's scope to restructure, but 4b must not add a path that
   reaches it: keep the editor's pre-validation (`validateSavedHost`) and record
   a rename+write-failure test as a Plan 5 candidate.
6. **Surface only.** No plaintext on the record or in `localStorage` (ids only);
   password field `type="password"` `autocomplete="new-password"`; tokens only,
   Chinese labels, ≥48px targets, `data-testid` as listed in Task 4b;
   `tests/unit/connectionEditorAuth.test.ts` keeps exactly ONE flat top-level
   `describe` (R14.5) and is registered in the manifest from a fresh report.

---

### Task 4a: Store wiring — credential, forget-on-save, forget-on-delete

**Files:**
- Modify: `src/stores/connections.ts`, `src/platform/android/hostStore.ts`
- Test: `tests/unit/connectionsCredentials.test.ts`

**Interfaces (per R29):**
- `ConnectionsStoreDeps` gains **optional** `secrets?: RememberedSecrets`.
- `AndroidHostStore.resolve(request, credential?)` uses a supplied credential and
  no longer refuses a password host when one is given.
- `connect(name)` resolves the credential through `buildSshCredential` first.
- `save(host, previousName?, secret?)` becomes async; `saveSecret(host, secret)`
  and `forgetSecrets(name)` are new.

- [ ] **Step 1: Write the failing tests**

The skeleton below shows the **real** dependency shape (`hosts`/`port`/`secrets`)
— do not copy the plan's earlier `readHosts`/`controller` sketch.

```ts
// tests/unit/connectionsCredentials.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createConnectionsStore } from '../../src/stores/connections';
import type { ConnectionPort } from '../../src/session/connectionPort';
import type { SavedHost } from '../../src/platform/android/hostStore';

const keyHost: SavedHost = {
  name: 'k', hostname: 'h', port: 22, user: 'u', keyHandleId: 'h-1',
  auth: { kind: 'key', keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1' },
};

function deps(hosts: SavedHost[], connect = vi.fn(async () => ({ ok: true }))) {
  const save = vi.fn();
  const remove = vi.fn();
  const resolve = vi.fn(async (request, credential) => ({
    hostId: `${request.user}@${request.host}:${request.port ?? 22}`,
    hostname: request.host, port: request.port ?? 22, username: request.user,
    credential: credential ?? { kind: 'key-handle', handleId: 'h-1', passphrase: null },
  }));
  const port = { connect, disconnect: vi.fn() } as unknown as ConnectionPort;
  const secrets = { resolve: vi.fn(async () => 'pw'), put: vi.fn(async () => 's-9'), forget: vi.fn(async () => {}) };
  return { hosts: { savedHosts: () => hosts, save, remove, resolve }, port, secrets };
}

describe('connections store credentials', () => {
  it('dials with the resolved passphrase', async () => {
    const d = deps([keyHost]);
    const store = createConnectionsStore(d as never);
    store.load();
    await store.connect('k');
    expect(d.secrets.resolve).toHaveBeenCalledWith('s-1');
    expect(d.port.connect).toHaveBeenCalledWith(
      expect.objectContaining({ credential: { kind: 'key-handle', handleId: 'h-1', passphrase: 'pw' } }),
    );
  });
  // …password host dials with the sealed password; a missing password fails the
  // dial with the /password/i copy and status 'error'; a key host with remember
  // off gets passphrase null and no lookup; save() forgets an unreferenced id;
  // remove() forgets both ids; saveSecret() seals with the right kind and writes
  // the id; a failing forget never blocks a save or a delete; forgetSecrets()
  // clears both ids; a rename moves the record without forgetting the kept id.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/connectionsCredentials.test.ts`
Expected: FAIL — no `secrets` dep, no `saveSecret`/`forgetSecrets`, `resolve` takes one argument.

- [ ] **Step 3: Implement (R29 rules)**

1. `src/platform/android/hostStore.ts`: `resolve(request, credential?)`; with a
   credential, use it and skip the password refusal (keep
   `MissingHostCredential` for a key host with no handle and **no** credential).
2. `src/stores/connections.ts`:
   - `secrets?: RememberedSecrets` with a fail-closed default
     (`resolve → null`, `forget → no-op`, `put → throws`), so every existing test
     keeps its old deps.
   - `connect`: build the credential from the found host's `auth` (or
     `{kind:'key', keyHandleId}` for a v1 record), wrap `buildSshCredential`'s
     rejection into `status:'error'` + `lastError` exactly like a failed resolve.
   - `save(host, previousName?, secret?)` async — seal a supplied secret with the
     kind implied by `auth`, write the id, then forget every id the **previous**
     record held but the new one does not (remember off, auth switch, or a
     replaced id). A forget failure is swallowed **after** the write.
   - `saveSecret(host, secret)` — seal + write, no rename.
   - `remove(name)` — forget the removed record's ids after the delete (a failure
     is swallowed), so the list always shrinks.
   - `forgetSecrets(name)` — forget every id the record holds, then rewrite it
     without them.
   - Bind `rememberedSecrets` in `useConnectionsStore`, and update
     `ConnectionsList.saveHost` to `void store.save(...)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/connectionsCredentials.test.ts tests/unit/connectionsStore.test.ts tests/unit/connectionsSwitchConfirm.test.ts tests/unit/connectionsPiDir.test.ts tests/unit/connectionsRename.test.ts`
Expected: PASS (new + existing all green).

- [ ] **Step 5: Commit**

```bash
git add src/stores/connections.ts src/platform/android/hostStore.ts tests/unit/connectionsCredentials.test.ts
git commit -m "feat(connections): dial with a remembered credential"
```

---

### Task 4b: The editor and the list

**Contract: R30 above is authoritative** — a secret is emitted only while the
remember toggle is on, `save` is awaited with the editor closing only on
success, clearing a saved password goes through `forgetSecrets`, and an explicit
forget failure is shown rather than swallowed. Each R30 clause needs its test in
`tests/unit/connectionEditorAuth.test.ts`.

**Files:**
- Modify: `src/components/connections/ConnectionEditor.vue`, `src/components/connections/ConnectionsList.vue`
- Create: `src/components/connections/LockIcon.vue` (core `AppIcon` has no `lock`
  glyph; copy `KeyIcon.vue`'s precedent)
- Test: `tests/unit/connectionEditorAuth.test.ts` (jsdom docblock +
  `testTransformMode.web` entry), plus list assertions in the same file or a
  second `describe` inside it (one flat top-level `describe` per file — put the
  list assertions in the same file only if they share the mount harness,
  otherwise a second file)

- [ ] **Step 1: Write the failing tests** — the editor renders a 密钥/密码 switch;
  choosing 密码 reveals a password field (`type="password"`,
  `autocomplete="new-password"`) and a 记住密码 toggle; choosing 密钥 keeps the key
  select and adds a 记住口令 toggle; 保存 is disabled until a key is chosen or a
  password is typed; editing a host with a saved credential shows 已保存 and a
  清除已保存凭据 button that emits `forget-credentials`; a typed secret is emitted
  with `save` (and the record carries no plaintext).
- [ ] **Step 2: RED** (`npx vitest run tests/unit/connectionEditorAuth.test.ts`)
- [ ] **Step 3: Implement** — bilingual-free Chinese labels, tokens only,
  ≥48px targets, `data-testid` (`auth-key`, `auth-password`, `password-input`,
  `remember-password`, `remember-passphrase`, `forget-credentials`). Emit
  `save: [host, secret: string | null]`; `ConnectionsList.saveHost` forwards the
  secret to `store.save(host, previousName, secret)` and
  `forget-credentials` to `store.forgetSecrets(name)`. The list shows
  `LockIcon` for a host whose `auth` references a secret
  (`passwordCredentialId`, or key + `rememberPassphrase` + `secretId`).
- [ ] **Step 4: GREEN** — the new file plus `connectionsStore`/`connectionsPiDir`
  suites; check `releaseChrome.test.ts` for banned words.
- [ ] **Step 5: Commit**

```bash
git add src/components/connections tests/unit/connectionEditorAuth.test.ts vitest.config.ts scripts/js-unit-test-manifest.json
git commit -m "feat(connections): key or password auth in the editor"
```


---

## Self-Review

- **Spec coverage:** §7.1 → Tasks 2, 3; §7.2 (password) → Tasks 1, 4a, 4b (native path
  already exists); §7.3 (remembered passphrase) → Tasks 1, 2, 4a, 4b; D2 → Global
  Constraints.
- **Review Focus:** RF1 → Task 1's throw test; RF2 → Task 1's null-passphrase
  test; RF3 → Task 4's forget-on-save test; RF4 → Task 2's `forTesting` and the
  no-log constraint.
- **Interface consistency:** `HostAuth` gains `secretId?` in Task 1, which Task 4a
  writes and Task 4b's editor renders; `SshCredential` is core's type, unchanged.
- **Explicitly not doing:** any change to `client.authPassword` or the key
  decryption path — both already work; biometric gating (not in spec).
- **Not verifiable here:** Task 2's JVM test and the package's compile both need
  a JDK (Plan 5 Task 1). Tasks 1, 3, 4a, 4b are pure JS and pass locally.

## Follow-on plans

5. `2026-10-19-cleanup-android-acceptance.md`
