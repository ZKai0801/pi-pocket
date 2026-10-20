<script setup lang="ts">
/**
 * The add/edit sheet for a saved host. Fields match spec §8.3 and §9.1: name,
 * host/IP, port, user, auth method, plus the per-host Pi session directory and
 * pi command the discovery path reads. A key host names a key handle; a
 * password host names an opaque credential id. A typed passphrase or password
 * leaves this sheet only as the `save` event's second argument, and only while
 * the matching remember toggle is on — never inside the record (Plan 4, R30).
 */
import { computed, onMounted, reactive, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import KeyIcon from '../KeyIcon.vue';
import { listSshKeys, type SshKeyMetadata } from '../../native/sshKeyVault';
import { piSessionsDirFor } from '../../pi/lastSessionRoot';
import { validateSavedHost, type HostAuth, type SavedHost } from '../../platform/android/hostStore';

type KeyAuth = Extract<HostAuth, { kind: 'key' }>;

const props = defineProps<{ host?: SavedHost | null; error?: string }>();
const emit = defineEmits<{
  save: [host: SavedHost, secret: string | null];
  cancel: [];
  'forget-credentials': [];
}>();

/** The opaque password id the edited record already holds, if any. */
function passwordIdOf(host: SavedHost | null | undefined): string {
  const auth = host?.auth;
  return auth?.kind === 'password' ? auth.passwordCredentialId : '';
}

/** The sealed passphrase id the edited record still reads at dial time. */
function keySecretIdOf(host: SavedHost | null | undefined): string {
  const auth = host?.auth;
  return auth?.kind === 'key' && auth.rememberPassphrase === true ? auth.secretId ?? '' : '';
}

const form = reactive({
  name: props.host?.name ?? '',
  hostname: props.host?.hostname ?? '',
  port: String(props.host?.port ?? 22),
  user: props.host?.user ?? '',
  authKind: props.host?.auth?.kind === 'password' ? 'password' : 'key',
  keyHandleId: props.host?.keyHandleId ?? '',
  // Both toggles start on: an edited host that holds a credential keeps it, and
  // a new host remembers a value the user types unless they turn it off.
  passphrase: '',
  rememberPassphrase: true,
  password: '',
  rememberPassword: true,
  piSessionsDir: piSessionsDirFor(props.host),
  piCommand: props.host?.piCommand ?? '',
});

const keys = ref<SshKeyMetadata[]>([]);
const keysError = ref('');
const error = ref('');

const isKeyAuth = computed(() => form.authKind === 'key');
const storedPasswordId = computed(() => passwordIdOf(props.host));
const storedKeySecretId = computed(() => keySecretIdOf(props.host));
const hasStoredCredential = computed(() => (isKeyAuth.value
  ? storedKeySecretId.value !== ''
  : storedPasswordId.value !== ''));
const canSave = computed(() => (isKeyAuth.value
  ? form.keyHandleId.trim() !== ''
  : form.password.length > 0 || storedPasswordId.value !== ''));
/** A failure from the list (a rejected save or clear) outranks a local hint. */
const shownError = computed(() => (props.error && props.error.length > 0 ? props.error : error.value));

onMounted(async () => {
  try {
    keys.value = await listSshKeys();
  } catch (caught) {
    keysError.value = caught instanceof Error && caught.message.length > 0
      ? caught.message
      : 'The key vault could not be read.';
  }
});

function selectAuth(kind: 'key' | 'password'): void {
  form.authKind = kind;
  error.value = '';
}

function buildAuth(): HostAuth {
  if (!isKeyAuth.value) {
    // R30 clause 3, route (i): an empty id is how "do not remember" reaches the
    // store, whose stale-id sweep then forgets the previous credential.
    return { kind: 'password', passwordCredentialId: form.rememberPassword ? storedPasswordId.value : '' };
  }
  if (!form.rememberPassphrase) return { kind: 'key', keyHandleId: form.keyHandleId };
  const typed = form.passphrase.length > 0;
  // A new value is sealed by the store; only a retained one is carried through.
  const keptSecretId = typed ? '' : storedKeySecretId.value;
  if (!typed && keptSecretId === '') return { kind: 'key', keyHandleId: form.keyHandleId };
  const auth: KeyAuth = { kind: 'key', keyHandleId: form.keyHandleId, rememberPassphrase: true };
  if (keptSecretId !== '') auth.secretId = keptSecretId;
  return auth;
}

/** The value the store may seal: only with its toggle on and only when typed. */
function typedSecret(): string | null {
  if (isKeyAuth.value) {
    return form.rememberPassphrase && form.passphrase.length > 0 ? form.passphrase : null;
  }
  return form.rememberPassword && form.password.length > 0 ? form.password : null;
}

function submit(): void {
  const host: SavedHost = {
    name: form.name.trim(),
    hostname: form.hostname.trim(),
    port: Number(form.port),
    user: form.user.trim(),
    keyHandleId: isKeyAuth.value ? form.keyHandleId : '',
    auth: buildAuth(),
  };
  if (form.piSessionsDir.trim()) host.piSessionsDir = form.piSessionsDir.trim();
  if (form.piCommand.trim()) host.piCommand = form.piCommand.trim();
  const problem = validateSavedHost(host);
  if (problem) {
    error.value = problem;
    return;
  }
  error.value = '';
  emit('save', host, typedSecret());
}
</script>

<template>
  <section class="connection-editor" aria-label="连接编辑">
    <header class="connection-editor__bar">
      <button type="button" class="connection-editor__close" aria-label="取消" @click="emit('cancel')">
        <AppIcon name="close" />
      </button>
      <h2 class="connection-editor__title">{{ props.host ? '编辑连接' : '新增连接' }}</h2>
    </header>

    <form class="connection-editor__form" @submit.prevent="submit">
      <label class="connection-editor__field">
        <span class="connection-editor__label">名称</span>
        <input v-model="form.name" type="text" autocomplete="off" placeholder="kai" />
      </label>

      <label class="connection-editor__field">
        <span class="connection-editor__label">主机 / IP</span>
        <input v-model="form.hostname" type="text" autocomplete="off" inputmode="url" placeholder="192.168.1.3" />
      </label>

      <label class="connection-editor__field">
        <span class="connection-editor__label">端口</span>
        <input v-model="form.port" type="text" inputmode="numeric" placeholder="22" />
      </label>

      <label class="connection-editor__field">
        <span class="connection-editor__label">用户</span>
        <input v-model="form.user" type="text" autocomplete="off" placeholder="kai" />
      </label>

      <fieldset class="connection-editor__auth">
        <legend class="connection-editor__label">认证方式</legend>
        <div class="connection-editor__segments">
          <button
            type="button"
            class="connection-editor__segment"
            :class="{ 'connection-editor__segment--active': isKeyAuth }"
            :aria-pressed="isKeyAuth"
            data-testid="auth-key"
            @click="selectAuth('key')"
          >
            <KeyIcon :size="16" /> 密钥
          </button>
          <button
            type="button"
            class="connection-editor__segment"
            :class="{ 'connection-editor__segment--active': !isKeyAuth }"
            :aria-pressed="!isKeyAuth"
            data-testid="auth-password"
            @click="selectAuth('password')"
          >
            密码
          </button>
        </div>
      </fieldset>

      <template v-if="isKeyAuth">
        <label class="connection-editor__field">
          <span class="connection-editor__label">密钥</span>
          <select v-model="form.keyHandleId">
            <option value="">选择密钥…</option>
            <option v-for="key in keys" :key="key.handleId" :value="key.handleId">{{ key.label }}</option>
          </select>
        </label>
        <p v-if="keysError" class="connection-editor__hint connection-editor__hint--error">{{ keysError }}</p>
        <p v-else-if="keys.length === 0" class="connection-editor__hint">
          密钥库为空 — 先在密钥页导入一把密钥。
        </p>
        <label class="connection-editor__field">
          <span class="connection-editor__label">口令</span>
          <input
            v-model="form.passphrase"
            type="password"
            autocomplete="new-password"
            data-testid="passphrase-input"
            :placeholder="storedKeySecretId && form.rememberPassphrase ? '已保存，留空则保留' : '密钥没有口令可留空'"
          />
        </label>
        <label class="connection-editor__toggle">
          <input v-model="form.rememberPassphrase" type="checkbox" data-testid="remember-passphrase" />
          <span class="connection-editor__toggle-label">记住口令</span>
        </label>
      </template>

      <template v-else>
        <label class="connection-editor__field">
          <span class="connection-editor__label">密码</span>
          <input
            v-model="form.password"
            type="password"
            autocomplete="new-password"
            data-testid="password-input"
            :placeholder="storedPasswordId && form.rememberPassword ? '已保存，留空则保留' : '登录密码'"
          />
        </label>
        <label class="connection-editor__toggle">
          <input v-model="form.rememberPassword" type="checkbox" data-testid="remember-password" />
          <span class="connection-editor__toggle-label">记住密码</span>
        </label>
      </template>

      <div v-if="hasStoredCredential" class="connection-editor__stored">
        <p class="connection-editor__hint">已保存</p>
        <button
          type="button"
          class="connection-editor__forget"
          data-testid="forget-credentials"
          @click="emit('forget-credentials')"
        >
          清除已保存凭据
        </button>
      </div>

      <label class="connection-editor__field">
        <span class="connection-editor__label">Pi 会话目录</span>
        <input v-model="form.piSessionsDir" type="text" autocomplete="off" spellcheck="false" placeholder="留空则自动探测" />
      </label>

      <label class="connection-editor__field">
        <span class="connection-editor__label">Pi 命令</span>
        <input v-model="form.piCommand" type="text" autocomplete="off" spellcheck="false" placeholder="pi" />
      </label>

      <p
        v-if="shownError"
        class="connection-editor__hint connection-editor__hint--error"
        role="alert"
        data-testid="editor-error"
      >{{ shownError }}</p>

      <div class="connection-editor__actions">
        <button type="button" class="connection-editor__cancel" @click="emit('cancel')">取消</button>
        <button type="submit" class="connection-editor__save" :disabled="!canSave">保存</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.connection-editor {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface);
  padding: var(--sp-3);
}

.connection-editor__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.connection-editor__close {
  display: inline-flex;
  width: 48px;
  height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--fg-secondary);
}

.connection-editor__close:focus-visible,
.connection-editor__segment:focus-visible,
.connection-editor__cancel:focus-visible,
.connection-editor__save:focus-visible,
.connection-editor__forget:focus-visible,
.connection-editor__toggle input:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.connection-editor__title {
  margin: 0;
  color: var(--fg);
  font-size: var(--fs-500);
  font-weight: var(--fw-semibold);
}

.connection-editor__form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.connection-editor__field {
  display: grid;
  gap: var(--sp-1);
}

.connection-editor__label {
  color: var(--fg-secondary);
  font-size: var(--fs-100);
  font-weight: var(--fw-medium);
}

.connection-editor__field input,
.connection-editor__field select {
  width: 100%;
  min-width: 0;
  min-height: 48px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--bg);
  padding: 0 var(--sp-2);
  color: var(--fg);
  font: var(--fs-300) var(--font-ui);
  outline: none;
}

.connection-editor__field input:focus,
.connection-editor__field select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.connection-editor__auth {
  margin: 0;
  border: 0;
  padding: 0;
}

.connection-editor__segments {
  display: flex;
  gap: var(--sp-1);
  margin-top: var(--sp-1);
}

.connection-editor__segment {
  display: inline-flex;
  min-height: 48px;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  gap: var(--sp-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--fg-secondary);
  font: var(--fw-medium) var(--fs-200) / 1 var(--font-ui);
}

.connection-editor__segment--active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.connection-editor__toggle {
  display: flex;
  min-height: 48px;
  align-items: center;
  gap: var(--sp-2);
}

.connection-editor__toggle input {
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  accent-color: var(--accent);
}

.connection-editor__toggle-label {
  color: var(--fg);
  font-size: var(--fs-300);
}

.connection-editor__stored {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  padding: var(--sp-1) var(--sp-2);
}

.connection-editor__forget {
  display: inline-flex;
  min-height: 48px;
  align-items: center;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface);
  padding: 0 var(--sp-2);
  color: var(--error);
  font: var(--fw-medium) var(--fs-200) / 1 var(--font-ui);
}

.connection-editor__hint {
  margin: 0;
  color: var(--fg-secondary);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.connection-editor__hint--error {
  color: var(--error);
}

.connection-editor__actions {
  display: flex;
  gap: var(--sp-2);
}

.connection-editor__cancel,
.connection-editor__save {
  display: inline-flex;
  min-width: 48px;
  min-height: 48px;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  font: var(--fw-semibold) var(--fs-300) / 1 var(--font-ui);
}

.connection-editor__cancel {
  background: var(--surface-2);
  color: var(--fg);
}

.connection-editor__save {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}

.connection-editor__save:disabled {
  opacity: var(--disabled-opacity);
  cursor: not-allowed;
}
</style>
