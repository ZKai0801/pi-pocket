/**
 * F4 guard (R35): every sentence the add-a-connection flow can put on screen
 * is Chinese, and the sentences it used to show are gone from the files that
 * author them.
 *
 * `releaseChrome.test.ts` bans internal jargon, not language, so an English
 * sentence could come back on this path with the whole suite green. This is
 * the assertion for that: one explicit inventory of the strings this flow
 * renders, each entry naming the file that *authors* the string, asserting the
 * Chinese is present there and the English is absent **there**. That last word
 * is R40: a half-finished translation that moves a sentence to another file
 * leaves this guard red, where a guard grepping the rendering component would
 * pass for the wrong reason. The inventory must stay complete (`FLOOR`) and
 * every entry must stay real, so it cannot be emptied to pass.
 *
 * THE BOUNDARY — read this before "finishing" a translation you find missing.
 * JS-owned user-facing copy on this path is Chinese. Two families stay English
 * because they are **not JS-owned at all**, plus one named class of exception:
 *
 *  1. The Android plugin's own prose. It arrives as `cause.message` through
 *     `failureMessage(cause, …)` in `src/components/SshKeysScreen.vue` (e.g.
 *     "This is a public key. Paste the private key instead; it starts with a
 *     BEGIN line.") and through `keysError` in
 *     `src/components/connections/ConnectionEditor.vue`. JS cannot translate a
 *     sentence it did not author without parsing English prose, so the fix is
 *     for the plugin to return **codes rather than sentences** — a
 *     native-contract change recorded as residual in
 *     `docs/superpowers/plans/2026-10-21-key-import-and-connection-copy.md`,
 *     and out of this plan's scope.
 *  2. Native-contract validation in `src/native/sshKeyVault.ts`
 *     (`parseSshKeyMetadata`, `parseSshPublicKeyLine`, `listSshKeys`). These
 *     sentences name a broken plugin reply rather than anything the user did;
 *     they are diagnostics the plugin contract owns, not screen copy.
 *
 * EXCEPTION (JS-owned, but a *contract* family — R41): `hostStore.ts`'s
 * `MissingHostCredential` (declared at `src/platform/android/hostStore.ts:63`,
 * its message the `super(...)` at `:68`, thrown at `:246`), the two other
 * English throws in the same file (`:244`, a password credential that is not
 * available yet; `:264`, no saved host for the request), and
 * `UnsupportedHostAuth` in `src/credentials/buildSshCredential.ts`. These are
 * JS-owned, but they are a store/contract surface rather than screen copy: their
 * consumers include the unreachable shared app, so changing them is a contract
 * change rather than a translation. `validateSavedHost`'s five sentences
 * (`hostStore.ts:133-139`) are the same case — they stay byte-identical because
 * the wrapper is a public contract with a test pinning the exact sentences
 * (`tests/unit/hostStoreAuth.test.ts`), not because the shared app is
 * reachable. Fixing any of these is out of this plan's scope. The
 * `MissingHostCredential` a user actually sees arrives via `connections.ts:399`/
 * `:417`/`:426` → `ConnectionsList.vue:206`; no task in this plan makes it
 * Chinese.
 *
 * The last tests below pin that boundary, so this note cannot rot silently:
 * translating a listed family turns them red, and so does adding a translatable
 * family to the list.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { SshCredential, SshHostTarget } from '@pocketshell/core';
import SshKeysScreen from '../../src/components/SshKeysScreen.vue';
import { createConnectionsStore } from '../../src/stores/connections';
import type { ConnectionPort } from '../../src/session/connectionPort';
import type { CredentialKeyManager } from '../../src/credentials/keyManagement';
import { UnsupportedHostAuth } from '../../src/credentials/buildSshCredential';
import { parseSshKeyMetadata, type SshKeyMetadata } from '../../src/native/sshKeyVault';
import type { SavedHost } from '../../src/platform/android/hostStore';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const MESSAGES = 'src/i18n/messages.ts';
const EDITOR = 'src/components/connections/ConnectionEditor.vue';
const KEYS = 'src/components/SshKeysScreen.vue';
const STORE = 'src/stores/connections.ts';
/** The dial's credential builder: its one user-actionable error is Chinese. */
const CREDENTIALS = 'src/credentials/buildSshCredential.ts';
/** The key manager: JS-owned validation and policy behind the key sheet. */
const KEY_MANAGEMENT = 'src/credentials/keyManagement.ts';

function source(file: string): string {
  return readFileSync(path.join(repoRoot, file), 'utf8');
}

/**
 * Every sentence this flow renders: `[authoring file, English it used to show,
 * Chinese it shows now]`. The English side is the exact former copy, so a
 * revert (or a half-finished translation) names the string that came back.
 */
const COPY: Array<[string, string, string]> = [
  // — the editor's validation problems and its vault-read fallback —
  [MESSAGES, "Enter a name.", "请填写名称。"],
  [MESSAGES, "Enter a hostname or IP address.", "请填写主机名或 IP 地址。"],
  [MESSAGES, "Enter the login user.", "请填写登录用户。"],
  [MESSAGES, "The port must be between 1 and 65535.", "端口需在 1–65535 之间。"],
  [MESSAGES, "Pick a key from the key vault.", "请从密钥库选择一把密钥。"],
  [MESSAGES, "Could not read the key vault.", "无法读取密钥库。"],
  // — the store's user-visible errors (rendered by ConnectionsList) —
  [MESSAGES, "Could not open a connection.", "无法建立连接。"],
  [MESSAGES, "No saved connection named \"{name}\".", "没有名为「{name}」的已保存连接。"],
  [MESSAGES, "Could not connect to \"{name}\".", "无法连接到「{name}」。"],
  [MESSAGES, "The connection list is still loading; try again shortly.", "连接列表还在加载，请稍后再试。"],
  [MESSAGES, "This host's saved password is gone; enter it again in the connection editor.", "这台主机保存的密码已丢失，请在连接编辑页重新输入。"],
  // — the one user-actionable credential error that reaches the same alert —
  [MESSAGES, "Private keys stay in this device's encrypted storage; only labels, fingerprints and public keys are shown here.", "私钥只保存在本机加密存储中，这里只显示标签、指纹和公钥。"],
  // — the key sheet: what it says about the vault and its list —
  [MESSAGES, "Saved keys", "已保存的密钥"],
  [MESSAGES, "No keys yet", "还没有密钥"],
  [MESSAGES, "Paste a private key below, import a key file, or generate a new key.", "在下方粘贴私钥、导入密钥文件，或生成一把新密钥。"],
  [MESSAGES, "· passphrase required", "· 需要口令"],
  [MESSAGES, "Delete {label}", "删除 {label}"],
  [MESSAGES, "Public key · copy, share or install", "公钥 · 复制、分享或安装"],
  [MESSAGES, "Add the line below to {path} on every server you want to connect to.", "把下面这一行加到每台要连接的服务器上的 {path} 中。"],
  // — the public-key panel —
  [MESSAGES, "Reading public key…", "正在读取公钥…"],
  [MESSAGES, "Key passphrase · used only to read this public key", "密钥口令 · 仅用于读取这一次公钥"],
  [MESSAGES, "Show public key", "显示公钥"],
  [MESSAGES, "Copy", "复制"],
  [MESSAGES, "Share", "分享"],
  [MESSAGES, "Install on {host}", "安装到 {host}"],
  [MESSAGES, "Once a host is connected, you can install this key on it in one step.", "连接主机后，可以把这把密钥一步安装到主机上。"],
  [MESSAGES, "Install {key} on {host}?", "把 {key} 安装到 {host}？"],
  [MESSAGES, "PocketShell appends this public key to {path} on the connected host; keys already in the file are left untouched.", "PocketShell 会把这条公钥加到已连接主机的 {path} 中；文件中已有的密钥不会被改动。"],
  [MESSAGES, "Cancel", "取消"],
  [MESSAGES, "Installing…", "正在安装…"],
  [MESSAGES, "Install key", "安装密钥"],
  [MESSAGES, "Delete {key}?", "删除 {key}？"],
  // — deleting a key —
  [MESSAGES, "These saved connections use this key; their links are removed before it is deleted:", "这把密钥正在被以下已保存的连接使用，删除前会先解除这些关联："],
  [MESSAGES, "Deleting…", "正在删除…"],
  [MESSAGES, "Unlink and delete key", "解除关联并删除密钥"],
  [MESSAGES, "Key deleted; {count} hosts unlinked.", "密钥已删除，已解除 {count} 个主机的关联。"],
  [MESSAGES, "Key deleted.", "密钥已删除。"],
  [MESSAGES, "Add key", "添加密钥"],
  // — adding a key —
  [MESSAGES, "Ways to add a key", "添加密钥的方式"],
  [MESSAGES, "Paste", "粘贴"],
  [MESSAGES, "File", "文件"],
  [MESSAGES, "Generate", "生成"],
  [MESSAGES, "Private key", "私钥"],
  [MESSAGES, "Paste the private key here", "在此粘贴私钥"],
  [MESSAGES, "Paste the complete private key (Ed25519 or RSA), including the BEGIN and END lines.", "粘贴完整的私钥（Ed25519 或 RSA），包括开头的 BEGIN 行和结尾的 END 行。"],
  [MESSAGES, "It is stored encrypted on this device, and this field is cleared straight after.", "内容会加密保存在本机，这个输入框随后立即清空。"],
  [MESSAGES, "Key label", "密钥标签"],
  [MESSAGES, "My laptop", "我的笔记本"],
  [MESSAGES, "Passphrase (if the key has one)", "口令（如果密钥有口令）"],
  [MESSAGES, "Importing…", "正在导入…"],
  [MESSAGES, "Import pasted private key", "导入粘贴的私钥"],
  [MESSAGES, "Ed25519 and RSA keys are supported.", "支持 Ed25519 与 RSA 密钥。"],
  [MESSAGES, "Choose a private key file", "选择私钥文件"],
  [MESSAGES, "Algorithm", "算法"],
  [MESSAGES, "A new key stays in this device's encrypted storage.", "新密钥只保存在本机加密存储中。"],
  [MESSAGES, "Generating…", "正在生成…"],
  [MESSAGES, "Generate {algorithm}", "生成 {algorithm}"],
  [MESSAGES, "{label} saved to this device's encrypted storage.", "{label} 已保存到本机加密存储。"],
  // — the sheet's own status and error sentences —
  [MESSAGES, "{label} generated. Add its public key to the server to use it.", "{label} 已生成。把它的公钥添加到服务器后即可使用。"],
  [MESSAGES, "Could not import the key.", "密钥导入失败。"],
  [MESSAGES, "The paste box was cleared; paste it again and retry.", "粘贴框已清空，请重新粘贴后重试。"],
  [MESSAGES, "Could not generate the key.", "密钥生成失败。"],
  [MESSAGES, "Could not delete the key.", "无法删除密钥。"],
  [MESSAGES, "Could not read the public key.", "无法读取公钥。"],
  [MESSAGES, "Could not copy the public key.", "无法复制公钥。"],
  [MESSAGES, "Could not share the public key.", "无法分享公钥。"],
  [MESSAGES, "Public key copied. Paste it into the server's {path}.", "公钥已复制。请粘贴到服务器的 {path} 中。"],
  [MESSAGES, "Added to {host}. You can now connect with {key}.", "已添加到 {host}。现在可以用 {key} 连接了。"],
  [MESSAGES, "{host}'s {path} already has {key}; nothing changed.", "{host} 的 {path} 里已有 {key}，未做改动。"],
  [MESSAGES, "Could not add this key to that host.", "无法把这把密钥添加到该主机。"],
  [MESSAGES, "That key is no longer available; refresh the list and try again.", "所选密钥已不可用，请刷新列表后重试。"],
  // — the key manager behind the sheet: JS-owned errors and default labels —
  [MESSAGES, "The host key link changed before deletion; refresh the hosts and try again.", "主机密钥关联在删除前已变更，请刷新主机后重试。"],
  [MESSAGES, "The Android key store did not confirm the deletion.", "Android 密钥库未确认删除。"],
  [MESSAGES, "The key could not be deleted and the host links could not be restored; refresh the saved hosts before connecting.", "密钥删除失败且主机关联未能恢复，请在连接前刷新已保存的主机。"],
  [MESSAGES, "Select an SSH key first.", "请先选择一把 SSH 密钥。"],
  [MESSAGES, "Android returned no document reference for the SSH key.", "Android 未返回 SSH 密钥的文档引用。"],
  [MESSAGES, "Imported key", "导入的密钥"],
  [MESSAGES, "Paste a private key first.", "请先粘贴私钥。"],
  [MESSAGES, "Pasted key", "粘贴的密钥"],
];

/** The list may grow, never shrink: a translation is finished, not trimmed. */
const FLOOR = 60;

function metadata(overrides: Partial<SshKeyMetadata> = {}): SshKeyMetadata {
  return {
    handleId: 'k-1',
    label: 'kai@laptop',
    algorithm: 'ssh-ed25519',
    fingerprintSha256: 'SHA256:test',
    passphraseRequired: false,
    createdAt: 0,
    ...overrides,
  };
}

/** No method of this stub is called by a render; clicks are out of scope here. */
const manager = {} as unknown as CredentialKeyManager;

function renderKeys(options: {
  keys?: SshKeyMetadata[];
  loadError?: string;
} = {}): Promise<string> {
  return renderToString(createSSRApp({
    render: () => h(SshKeysScreen, {
      manager,
      keys: options.keys ?? [],
      selectedHandleId: '',
      loadError: options.loadError ?? '',
    }),
  }));
}

function keyHost(name = 'kai'): SavedHost {
  return { name, hostname: 'h', port: 22, user: 'u', keyHandleId: 'h-1', auth: { kind: 'key', keyHandleId: 'h-1' } };
}

const target: SshHostTarget = {
  hostId: 'u@h:22',
  hostname: 'h',
  port: 22,
  username: 'u',
  credential: { kind: 'key-handle', handleId: 'h-1', passphrase: null } as SshCredential,
};

function dialStore(hosts: SavedHost[], dial: () => Promise<{ ok: boolean }>) {
  return createConnectionsStore({
    hosts: {
      savedHosts: () => hosts,
      save: () => {},
      remove: () => {},
      resolve: async () => target,
    },
    port: { connect: dial, disconnect: async () => {} } as ConnectionPort,
  });
}

describe('connection copy (F4)', () => {
  it('shows every sentence of this flow in Chinese and none of them in English', () => {
    expect(COPY.length).toBeGreaterThanOrEqual(FLOOR);
    const hits: string[] = [];
    for (const [file, english, chinese] of COPY) {
      const text = source(file);
      if (!text.includes(chinese)) hits.push(`${file}: missing Chinese ${JSON.stringify(chinese)}`);
      // The copy table authors both languages on purpose: the sentence is
      // complete only when it reads in English too. What must never come back
      // is the English-only rendering — a screen that bypasses the table —
      // which the two tests below pin per component.
      if (!text.includes(english)) hits.push(`${file}: missing English ${JSON.stringify(english)}`);
    }
    expect(hits).toEqual([]);
    // Each file on the path is actually in the inventory, so a new screen
    // cannot join the flow without one of these entries.
    expect(new Set(COPY.map(([file]) => file))).toEqual(new Set([MESSAGES]));
  });

  it('asks the validator for a problem code instead of rendering its English sentence', () => {
    // The five sentences live in `hostStore.ts` for the shared app; the phone
    // shell must never reach them, so it must not even import the wrapper.
    expect(source(EDITOR)).not.toContain('validateSavedHost');
    expect(source(EDITOR)).toContain('savedHostProblem(host)');
  });

  it('renders the empty vault in Chinese', async () => {
    const html = await renderKeys();
    expect(html).toContain('还没有密钥');
    expect(html).toContain('在下方粘贴私钥、导入密钥文件，或生成一把新密钥。');
    expect(html).toContain('添加密钥');
    expect(html).not.toContain('No SSH keys yet');
    expect(html).not.toContain('Add an SSH key');
    // The screen is still the one the editor's sheet mounts (testids intact).
    expect(html).toContain('data-testid="ssh-keys-screen"');
    expect(html).toContain('data-testid="ssh-key-paste-text"');
  });

  it('renders a stored key row in Chinese, including its public-key control', async () => {
    const html = await renderKeys({ keys: [metadata({ passphraseRequired: true })] });
    expect(html).toContain('aria-label="删除 kai@laptop"');
    expect(html).toContain('· 需要口令');
    expect(html).toContain('公钥 · 复制、分享或安装');
    expect(html).not.toContain('Delete kai@laptop');
    expect(html).not.toContain('passphrase required');
    expect(html).not.toContain('Public key · copy, share or install');
  });

  it('shows a vault-read failure as the error it was handed, with Chinese chrome around it', async () => {
    const html = await renderKeys({ loadError: '密钥库无法解锁' });
    expect(html).toContain('密钥库无法解锁');
    expect(html).toContain('data-testid="ssh-key-load-error"');
    expect(html).toContain('已保存的密钥');
  });

  it('reports a failed dial and an unknown host in Chinese', async () => {
    const refused = dialStore([keyHost()], async () => ({ ok: false }));
    refused.load();
    await refused.connect('kai');
    expect(refused.lastError).toBe('无法连接到「kai」。');

    const thrown = dialStore([keyHost()], async () => { throw new Error('nope'); });
    thrown.load();
    await thrown.connect('kai');
    expect(thrown.lastError).toBe('nope');

    const unknown = dialStore([keyHost()], async () => ({ ok: true }));
    unknown.load();
    await unknown.connect('ghost');
    // A validation failure, not a dial: the name the user asked for stays in
    // the sentence so the row it belongs to is identifiable.
    expect(unknown.lastError).toBe('没有名为「ghost」的已保存连接。');
  });

  it('keeps the boundary honest: native-contract and impossible failures stay English', () => {
    // Family 2 of the note at the top of this file, and its declared exception.
    // Translating either means the boundary moved, so this test must move with
    // it — that is the point: an undocumented mixed-language error cannot appear
    // unnoticed.
    expect(() => parseSshKeyMetadata({ handleId: 'k-1' }))
      .toThrow('The Android key vault returned invalid public metadata.');
    expect(new UnsupportedHostAuth('agent').message).toBe('Unsupported saved-host auth method: agent.');
    // …and the family the shell *can* own is Chinese (C1, F4).
    expect(source(MESSAGES)).toContain('这台主机保存的密码已丢失，请在连接编辑页重新输入。');
  });

  it('keeps the boundary note from re-absorbing a translatable family', () => {
    // R41: the note may name non-JS-owned families and the declared contract
    // exception, nothing else. This file's header JSDoc *is* the note; if it
    // grows a line saying a translatable file "stays English", the note has
    // become a list of excuses again. Reading the note text rather than the
    // constants means the inventory may name the file without satisfying this.
    const self = source('tests/unit/connectionCopy.test.ts');
    const note = self.slice(0, self.indexOf('*/'));
    expect(note.length).toBeGreaterThan(0);
    expect(note).not.toContain('keyManagement');
  });
});
