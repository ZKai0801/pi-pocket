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
 * its message the `super(...)` at `:68`, thrown at `:245`), the two other
 * English throws in the same file (`:243`, a password credential that is not
 * available yet; `:263`, no saved host for the request), and
 * `UnsupportedHostAuth` in `src/credentials/buildSshCredential.ts`. These are
 * JS-owned, but they are a store/contract surface rather than screen copy: their
 * consumers include the unreachable shared app, so changing them is a contract
 * change rather than a translation. `validateSavedHost`'s five sentences
 * (`hostStore.ts:132-138`) are the same case — they stay byte-identical because
 * the wrapper is a public contract with a test pinning the exact sentences
 * (`tests/unit/hostStoreAuth.test.ts`), not because the shared app is
 * reachable. Fixing any of these is out of this plan's scope. The
 * `MissingHostCredential` a user actually sees arrives via `connections.ts:359`/
 * `:377`/`:386` → `ConnectionsList.vue:135`; no task in this plan makes it
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
  [EDITOR, 'Give the host a name.', '请填写名称。'],
  [EDITOR, 'Enter a hostname or IP address.', '请填写主机名或 IP 地址。'],
  [EDITOR, 'Enter the SSH user.', '请填写登录用户。'],
  [EDITOR, 'Port must be 1–65535.', '端口需在 1–65535 之间。'],
  [EDITOR, 'Choose an SSH key from the key vault.', '请从密钥库选择一把密钥。'],
  [EDITOR, 'The key vault could not be read.', '无法读取密钥库。'],
  // — the store's user-visible errors (rendered by ConnectionsList) —
  [STORE, 'The connection could not be opened.', '无法建立连接。'],
  [STORE, 'No saved host named “${name}”.', '没有名为「${name}」的已保存连接。'],
  [STORE, 'The connection to “${host.name}” did not open.', '无法连接到「${host.name}」。'],
  [STORE, 'The saved hosts are still loading.', '连接列表还在加载，请稍后再试。'],
  // — the one user-actionable credential error that reaches the same alert —
  [CREDENTIALS, 'The saved password for this host is missing — enter it again in the connection editor.',
    '这台主机保存的密码已丢失，请在连接编辑页重新输入。'],
  // — the key sheet: what it says about the vault and its list —
  [KEYS, '<h1>SSH keys</h1>', '<h1>密钥</h1>'],
  [KEYS, 'Private keys stay encrypted in Android storage.', '私钥只保存在本机加密存储中'],
  [KEYS, 'Stored keys', '已保存的密钥'],
  [KEYS, 'No SSH keys yet', '还没有密钥'],
  [KEYS, 'Paste a private key, import a key file, or generate a new key below.', '在下方粘贴私钥、导入密钥文件，或生成一把新密钥。'],
  [KEYS, 'passphrase required', '需要口令'],
  [KEYS, '`Delete ${key.label}`', '`删除 ${key.label}`'],
  [KEYS, 'Public key · copy, share or install', '公钥 · 复制、分享或安装'],
  // — the public-key panel —
  [KEYS, 'on each server you want to reach.', '加到每台要连接的服务器上的'],
  [KEYS, 'Reading the public key…', '正在读取公钥…'],
  [KEYS, 'Key passphrase · used once to read the public key', '密钥口令 · 仅用于读取这一次公钥'],
  [KEYS, '>Show public key<', '>显示公钥<'],
  [KEYS, '>Copy<', '>复制<'],
  [KEYS, '>Share<', '>分享<'],
  [KEYS, '>Install on {{ hostInstall.hostLabel }}<', '>安装到 {{ hostInstall.hostLabel }}<'],
  [KEYS, 'Connect to a host to install this key there in one step.', '连接主机后，可以把这把密钥一步安装到主机上。'],
  [KEYS, 'Install {{ key.label }} on {{ hostInstall.hostLabel }}?', '把 {{ key.label }} 安装到 {{ hostInstall.hostLabel }}？'],
  [KEYS, 'PocketShell will add this public key to', 'PocketShell 会把这条公钥加到已连接主机的'],
  [KEYS, 'A key that is already listed is left unchanged.', '文件中已有的密钥不会被改动。'],
  [KEYS, '>Cancel<', '>取消<'],
  [KEYS, "publicBusy ? 'Installing…' : 'Install key'", "publicBusy ? '正在安装…' : '安装密钥'"],
  // — deleting a key —
  [KEYS, 'Remove {{ pendingDelete.key.label }}?', '删除 {{ pendingDelete.key.label }}？'],
  [KEYS, 'This key is attached to these saved hosts.', '这把密钥正在被以下已保存的连接使用'],
  [KEYS, "busy ? 'Removing…' : 'Remove associations and delete key'", "busy ? '正在删除…' : '解除关联并删除密钥'"],
  [KEYS, 'Key removed. ${hosts} host', '密钥已删除，已解除 ${hosts} 个主机的关联。'],
  [KEYS, ": 'Key removed.'", ": '密钥已删除。'"],
  // — adding a key —
  [KEYS, 'Add an SSH key', '添加密钥'],
  [KEYS, 'aria-label="How to add an SSH key"', 'aria-label="添加密钥的方式"'],
  [KEYS, '>Paste<', '>粘贴<'],
  [KEYS, '>File<', '>文件<'],
  [KEYS, '>Generate<', '>生成<'],
  [KEYS, '<span>Private key</span>', '<span>私钥</span>'],
  [KEYS, 'placeholder="Paste your private key here"', 'placeholder="在此粘贴私钥"'],
  [KEYS, 'Paste the whole private key (Ed25519 or RSA), including its BEGIN and END lines.', '粘贴完整的私钥（Ed25519 或 RSA），包括开头的 BEGIN 行和结尾的 END 行。'],
  [KEYS, 'It is sealed in Android secure storage and this field is cleared right away.', '内容会加密保存在本机，这个输入框随后立即清空。'],
  [KEYS, '<span>Key label</span>', '<span>密钥标签</span>'],
  [KEYS, 'placeholder="Personal laptop"', 'placeholder="我的笔记本"'],
  [KEYS, 'Passphrase, if the key has one', '口令（如果密钥有口令）'],
  [KEYS, "busy ? 'Importing…' : 'Import pasted key'", "busy ? '正在导入…' : '导入粘贴的私钥'"],
  [KEYS, 'Supported key algorithms: Ed25519 and RSA.', '支持 Ed25519 与 RSA 密钥。'],
  [KEYS, "busy ? 'Importing…' : 'Choose private key file'", "busy ? '正在导入…' : '选择私钥文件'"],
  [KEYS, '<span>Algorithm</span>', '<span>算法</span>'],
  [KEYS, 'The new key stays in Android secure storage.', '新密钥只保存在本机加密存储中。'],
  [KEYS, "busy ? 'Generating…' : `Generate ${algorithm}`", "busy ? '正在生成…' : `生成 ${algorithm}`"],
  // — the sheet's own status and error sentences —
  [KEYS, 'is stored in Android secure storage.', '已保存到本机加密存储。'],
  [KEYS, 'was generated. Add its public key to your server to use it.', '已生成。把它的公钥添加到服务器后即可使用。'],
  [KEYS, 'The SSH key could not be imported.', '密钥导入失败。'],
  [KEYS, 'The pasted text was cleared; paste it again to retry.', '粘贴框已清空，请重新粘贴后重试。'],
  [KEYS, 'The SSH key could not be generated.', '密钥生成失败。'],
  [KEYS, 'The SSH key could not be removed.', '无法删除密钥。'],
  [KEYS, 'The public key could not be read.', '无法读取公钥。'],
  [KEYS, 'The public key could not be copied.', '无法复制公钥。'],
  [KEYS, 'The public key could not be shared.', '无法分享公钥。'],
  [KEYS, 'Public key copied. Paste it into', '公钥已复制。请粘贴到服务器的'],
  [KEYS, 'Installed on ${target.hostLabel}.', '已添加到 ${target.hostLabel}。'],
  [KEYS, 'is already in ~/.ssh/authorized_keys on', '的 ~/.ssh/authorized_keys 里已有'],
  [KEYS, 'The key could not be installed on the host.', '无法把这把密钥添加到该主机。'],
  // — the key manager behind the sheet: JS-owned errors and default labels —
  [KEY_MANAGEMENT, 'Android did not return a document reference for the SSH key.', 'Android 未返回 SSH 密钥的文档引用。'],
  [KEY_MANAGEMENT, 'Imported SSH key', '导入的密钥'],
  [KEY_MANAGEMENT, 'Paste a private key first.', '请先粘贴私钥。'],
  [KEY_MANAGEMENT, 'Pasted SSH key', '粘贴的密钥'],
  [KEY_MANAGEMENT, 'The public key could not be copied.', '无法复制公钥。'],
  [KEY_MANAGEMENT, 'The public key could not be shared.', '无法分享公钥。'],
  [KEY_MANAGEMENT, 'The selected SSH key is no longer available. Refresh the list and try again.', '所选密钥已不可用，请刷新列表后重试。'],
  [KEY_MANAGEMENT, 'Host key associations changed before deletion. Refresh the hosts and try again.', '主机密钥关联在删除前已变更，请刷新主机后重试。'],
  [KEY_MANAGEMENT, 'The Android key vault did not confirm key removal.', 'Android 密钥库未确认删除。'],
  [KEY_MANAGEMENT, 'Key removal failed and host associations could not be restored. Refresh saved hosts before connecting.', '密钥删除失败且主机关联未能恢复，请在连接前刷新已保存的主机。'],
  [KEY_MANAGEMENT, 'Select an SSH key before connecting.', '请先选择一把 SSH 密钥。'],
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
      if (text.includes(english)) hits.push(`${file}: English is back ${JSON.stringify(english)}`);
    }
    expect(hits).toEqual([]);
    // Each file on the path is actually in the inventory, so a new screen
    // cannot join the flow without one of these entries.
    expect(new Set(COPY.map(([file]) => file))).toEqual(new Set([EDITOR, KEYS, STORE, CREDENTIALS, KEY_MANAGEMENT]));
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
    expect(source(CREDENTIALS)).toContain('这台主机保存的密码已丢失，请在连接编辑页重新输入。');
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
