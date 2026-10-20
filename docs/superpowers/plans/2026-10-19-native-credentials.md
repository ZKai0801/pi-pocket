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

### Task 4: Wire connect and the editor

**Files:**
- Modify: `src/stores/connections.ts`, `src/components/connections/ConnectionEditor.vue`, `src/components/connections/ConnectionsList.vue`
- Test: `tests/unit/connectionsCredentials.test.ts`

**Interfaces:**
- Consumes: `buildSshCredential` (Task 1), `RememberedSecrets` (Task 3).
- Produces: `useConnectionsStore()` gains `saveSecret(host, secret)`,
  `forgetSecrets(host)`, and `connect(name)` now resolves a credential before
  dialing.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/connectionsCredentials.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createConnectionsStore } from '../../src/stores/connections';

const keyHost = { name: 'k', hostname: 'h', port: 22, user: 'u',
  auth: { kind: 'key' as const, keyHandleId: 'h-1', rememberPassphrase: true, secretId: 's-1' } };

describe('connections store credentials', () => {
  it('dials with the resolved passphrase', async () => {
    const controller = { connect: vi.fn(async () => ({ ok: true })), disconnect: vi.fn() };
    const secrets = { resolve: vi.fn(async () => 'pw'), put: vi.fn(), forget: vi.fn() };
    const store = createConnectionsStore({ readHosts: () => [keyHost], writeHosts: vi.fn(), controller: controller as never, secrets: secrets as never });
    await store.load(); await store.connect('k');
    expect(controller.connect).toHaveBeenCalledWith(expect.objectContaining({ credential: { kind: 'key-handle', handleId: 'h-1', passphrase: 'pw' } }));
  });

  it('forgets the secret when a host stops remembering', async () => {
    const secrets = { resolve: vi.fn(), put: vi.fn(), forget: vi.fn(async () => {}) };
    const store = createConnectionsStore({ readHosts: () => [keyHost], writeHosts: vi.fn(), controller: {} as never, secrets: secrets as never });
    await store.load();
    await store.save({ ...keyHost, auth: { kind: 'key', keyHandleId: 'h-1', rememberPassphrase: false } });
    expect(secrets.forget).toHaveBeenCalledWith('s-1');
  });

  it('forgets the secret when a host is deleted', async () => {
    const secrets = { resolve: vi.fn(), put: vi.fn(), forget: vi.fn(async () => {}) };
    const store = createConnectionsStore({ readHosts: () => [keyHost], writeHosts: vi.fn(), controller: {} as never, secrets: secrets as never });
    await store.load(); await store.remove('k');
    expect(secrets.forget).toHaveBeenCalledWith('s-1');
  });

  it('stores a freshly typed password and references it by id', async () => {
    const secrets = { resolve: vi.fn(), put: vi.fn(async () => 's-9'), forget: vi.fn() };
    const writeHosts = vi.fn();
    const store = createConnectionsStore({ readHosts: () => [], writeHosts, controller: {} as never, secrets: secrets as never });
    await store.load();
    await store.saveSecret({ name: 'p', hostname: 'h', port: 22, user: 'u', auth: { kind: 'password', passwordCredentialId: '' } }, 'pw');
    expect(secrets.put).toHaveBeenCalledWith('pw', undefined);
    expect(writeHosts).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({ auth: { kind: 'password', passwordCredentialId: 's-9' } })]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/connectionsCredentials.test.ts`
Expected: FAIL — the store has no `secrets` dependency, `saveSecret` or `forgetSecrets`.

- [ ] **Step 3: Implement**

Inject `secrets` alongside `controller`. `connect` builds the credential with
`buildSshCredential(host.auth, (id) => secrets.resolve(id))` and passes it to
`controller.connect`. `save` compares the incoming and stored `auth` and, when
the old `secretId` is no longer referenced, calls `secrets.forget` (Review Focus
3). `remove` forgets first, then writes the list. `saveSecret` seals a typed
password/passphrase and writes the returned id into the host record. Then the
editor: an auth-method switch (密钥 / 密码), a password field with a 记住密码
toggle, and a 记住口令 toggle on the key path plus a 清除已保存凭据 action; the
list shows a lock glyph on hosts with a remembered secret.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/connectionsCredentials.test.ts tests/unit/connectionsStore.test.ts`
Expected: PASS (4 + 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stores/connections.ts src/components/connections tests/unit/connectionsCredentials.test.ts
git commit -m "feat(connections): password auth and remembered credentials in the editor"
```

---

## Self-Review

- **Spec coverage:** §7.1 → Tasks 2, 3; §7.2 (password) → Tasks 1, 4 (native path
  already exists); §7.3 (remembered passphrase) → Tasks 1, 2, 4; D2 → Global
  Constraints.
- **Review Focus:** RF1 → Task 1's throw test; RF2 → Task 1's null-passphrase
  test; RF3 → Task 4's forget-on-save test; RF4 → Task 2's `forTesting` and the
  no-log constraint.
- **Interface consistency:** `HostAuth` gains `secretId?` in Task 1, which Task 4
  writes and Plan 2's editor renders; `SshCredential` is core's type, unchanged.
- **Explicitly not doing:** any change to `client.authPassword` or the key
  decryption path — both already work; biometric gating (not in spec).
- **Not verifiable here:** Task 2's JVM test and the package's compile both need
  a JDK (Plan 5 Task 1). Tasks 1, 3, 4 are pure JS and pass locally.

## Follow-on plans

5. `2026-10-19-cleanup-android-acceptance.md`
