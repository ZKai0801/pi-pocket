<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import KeyIcon from './KeyIcon.vue';
import {
  type CredentialKeyManager,
  type DeleteKeyResult,
} from '@/credentials/keyManagement';
import type { AuthorizedKeyInstallResult } from '@/credentials/authorizedKeys';
import type { SshKeyMetadata } from '@/native/sshKeyVault';
import { t } from '../i18n';

export interface SshKeyHostInstallTarget {
  /** `user@host` of the live connection the key would be installed on. */
  hostLabel: string;
  install(publicKey: string): Promise<AuthorizedKeyInstallResult>;
}

const props = defineProps<{
  manager: CredentialKeyManager;
  keys: SshKeyMetadata[];
  selectedHandleId: string;
  loadError: string;
  hostInstall?: SshKeyHostInstallTarget | null;
}>();

const emit = defineEmits<{
  refresh: [];
  /** `stay` keeps the key screen open (a freshly generated key shows its public half). */
  select: [handleId: string, stay?: boolean];
}>();

const action = ref<'paste' | 'import' | 'generate'>('paste');
const label = ref('');
const passphrase = ref('');
const algorithm = ref<'Ed25519' | 'RSA-3072'>('Ed25519');
const busy = ref(false);
const message = ref('');
const error = ref('');
const pendingDelete = ref<{ key: SshKeyMetadata; result: Extract<DeleteKeyResult, { status: 'confirmation-required' }> } | null>(null);
const generateLabel = computed(() => label.value.trim() || t('keys.defaultLabel', { algorithm: algorithm.value }));

// The pasted private key lives only in the uncontrolled <textarea>: no
// reactive copy, no store. It is read once on Import and the field is
// cleared straight after, whatever the outcome (#3021).
const pasteInput = ref<HTMLTextAreaElement | null>(null);
const pasteHasText = ref(false);

// Public-key panel (#3021): public data only.
const expandedHandleId = ref('');
const publicLines = ref<Record<string, string>>({});
const publicBusy = ref(false);
const publicMessage = ref('');
const publicError = ref('');
const publicPassphraseNeeded = ref('');
const publicPassphrase = ref('');
const pendingInstallHandleId = ref('');

function clearPastedKey() {
  if (pasteInput.value) pasteInput.value.value = '';
  pasteHasText.value = false;
}

function notePasteInput() {
  pasteHasText.value = Boolean(pasteInput.value?.value.trim());
}

function chooseAction(next: 'paste' | 'import' | 'generate') {
  clearPastedKey();
  action.value = next;
  error.value = '';
  message.value = '';
}

function keepFieldVisible(event: FocusEvent) {
  // Let the IME finish resizing the viewport before centring the field.
  const target = event.target as HTMLElement | null;
  window.setTimeout(() => target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 300);
}

onBeforeUnmount(clearPastedKey);

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

async function importPastedKey() {
  const text = pasteInput.value?.value ?? '';
  clearPastedKey();
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const key = await props.manager.importText({ text, label: label.value, passphrase: passphrase.value });
    label.value = '';
    message.value = t('keys.savedMessage', { label: key.label });
    emit('select', key.handleId);
    emit('refresh');
  } catch (cause) {
    error.value = `${failureMessage(cause, t('keys.importFailed'))} ${t('keys.importFailedPaste')}`;
  } finally {
    passphrase.value = '';
    busy.value = false;
  }
}

async function importKey() {
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const key = await props.manager.pickAndImport({ label: label.value, passphrase: passphrase.value });
    if (key) {
      label.value = '';
      message.value = t('keys.savedMessage', { label: key.label });
      emit('select', key.handleId);
      emit('refresh');
    }
  } catch (cause) {
    error.value = failureMessage(cause, t('keys.importFailed'));
  } finally {
    passphrase.value = '';
    busy.value = false;
  }
}

async function generateKey() {
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    const key = await props.manager.generate({ label: generateLabel.value, algorithm: algorithm.value });
    label.value = '';
    message.value = t('keys.generatedMessage', { label: key.label });
    emit('select', key.handleId, true);
    emit('refresh');
    await showPublicKey(key);
  } catch (cause) {
    error.value = failureMessage(cause, t('keys.generateFailed'));
  } finally {
    busy.value = false;
  }
}

function resetPublicState() {
  publicMessage.value = '';
  publicError.value = '';
  publicPassphraseNeeded.value = '';
  publicPassphrase.value = '';
  pendingInstallHandleId.value = '';
}

async function togglePublicKey(key: SshKeyMetadata) {
  if (expandedHandleId.value === key.handleId) {
    expandedHandleId.value = '';
    resetPublicState();
    return;
  }
  await showPublicKey(key);
}

function needsPassphrase(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'KEY_PASSPHRASE_REQUIRED';
}

async function showPublicKey(key: Pick<SshKeyMetadata, 'handleId' | 'algorithm'>) {
  expandedHandleId.value = key.handleId;
  resetPublicState();
  if (publicLines.value[key.handleId]) return;
  await loadPublicKey(key);
}

async function loadPublicKey(key: Pick<SshKeyMetadata, 'handleId' | 'algorithm'>) {
  publicBusy.value = true;
  publicError.value = '';
  const secret = publicPassphrase.value;
  publicPassphrase.value = '';
  try {
    const line = await props.manager.publicKey(key, secret || undefined);
    publicLines.value = { ...publicLines.value, [key.handleId]: line };
    publicPassphraseNeeded.value = '';
  } catch (cause) {
    if (needsPassphrase(cause)) publicPassphraseNeeded.value = key.handleId;
    publicError.value = failureMessage(cause, t('keys.publicReadFailed'));
  } finally {
    publicBusy.value = false;
  }
}

async function copyPublicKey(key: SshKeyMetadata) {
  publicBusy.value = true;
  publicError.value = '';
  publicMessage.value = '';
  try {
    await props.manager.copyPublicKey(key.handleId);
    publicMessage.value = t('keys.publicCopied', { path: t('keys.authorizedKeysPath') });
  } catch (cause) {
    publicError.value = failureMessage(cause, t('keys.publicCopyFailed'));
  } finally {
    publicBusy.value = false;
  }
}

async function sharePublicKey(key: SshKeyMetadata) {
  publicBusy.value = true;
  publicError.value = '';
  publicMessage.value = '';
  try {
    await props.manager.sharePublicKey(key.handleId);
  } catch (cause) {
    publicError.value = failureMessage(cause, t('keys.publicShareFailed'));
  } finally {
    publicBusy.value = false;
  }
}

function requestInstall(key: SshKeyMetadata) {
  publicError.value = '';
  publicMessage.value = '';
  pendingInstallHandleId.value = key.handleId;
  // The confirmation renders below the fold on a phone; bring it into view.
  void nextTick(() => {
    const dialog = typeof document === 'undefined' ? null : document.querySelector('[data-testid=ssh-key-install-confirmation]');
    dialog?.scrollIntoView?.({ block: 'center' });
  });
}

async function confirmInstall(key: SshKeyMetadata) {
  const target = props.hostInstall;
  const line = publicLines.value[key.handleId];
  if (!target || !line) return;
  publicBusy.value = true;
  publicError.value = '';
  publicMessage.value = '';
  try {
    const result = await target.install(line);
    publicMessage.value = result === 'installed'
      ? t('keys.installed', { host: target.hostLabel, key: key.label })
      : t('keys.installAlready', { host: target.hostLabel, path: t('keys.authorizedKeysPath'), key: key.label });
  } catch (cause) {
    publicError.value = failureMessage(cause, t('keys.installFailed'));
  } finally {
    pendingInstallHandleId.value = '';
    publicBusy.value = false;
  }
}

async function requestDelete(key: SshKeyMetadata) {
  error.value = '';
  message.value = '';
  try {
    const result = await props.manager.delete(key.handleId);
    if (result.status === 'confirmation-required') {
      pendingDelete.value = { key, result };
      return;
    }
    finishDelete(key.handleId, result);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('keys.deleteFailed');
  }
}

async function confirmDelete() {
  const pending = pendingDelete.value;
  if (!pending) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await props.manager.delete(pending.key.handleId, pending.result.affectedHosts);
    if (result.status === 'confirmation-required') {
      pendingDelete.value = { key: pending.key, result };
      return;
    }
    finishDelete(pending.key.handleId, result);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('keys.deleteFailed');
  } finally {
    busy.value = false;
    pendingDelete.value = null;
  }
}

function finishDelete(handleId: string, result: Extract<DeleteKeyResult, { status: 'deleted' }>) {
  if (expandedHandleId.value === handleId) {
    expandedHandleId.value = '';
    resetPublicState();
  }
  const { [handleId]: _removed, ...remainingLines } = publicLines.value;
  publicLines.value = remainingLines;
  if (props.selectedHandleId === handleId) emit('select', '');
  const hosts = result.affectedHosts.length;
  message.value = hosts > 0
    ? t('keys.deleted', { count: hosts })
    : t('keys.deletedPlain');
  emit('refresh');
}

function cancelDelete() {
  pendingDelete.value = null;
}
</script>

<template>
  <main class="screen-content key-screen" data-testid="ssh-keys-screen">
    <section class="key-screen__intro">
      <h1>{{ t('keys.title') }}</h1>
      <p>{{ t('keys.intro') }}</p>
    </section>

    <section class="key-panel panel" aria-labelledby="ssh-key-list-title">
      <div class="panel-heading">
        <div>
          <h2 id="ssh-key-list-title">{{ t('keys.savedTitle') }}</h2>
        </div>
        <span class="state-tag state-tag--muted" data-testid="ssh-key-count">{{ keys.length }}</span>
      </div>
      <p v-if="loadError" class="connection-message" role="alert" data-testid="ssh-key-load-error">{{ loadError }}</p>

      <div v-if="keys.length === 0" class="key-empty" data-testid="ssh-key-empty">
        <KeyIcon :size="20" />
        <div>
          <strong>{{ t('keys.emptyTitle') }}</strong>
          <p>{{ t('keys.emptyBody') }}</p>
        </div>
      </div>
      <ul v-else class="key-list">
        <li v-for="key in keys" :key="key.handleId" class="key-row" :data-testid="`ssh-key-${key.handleId}`">
          <div class="key-row__main">
            <button
              class="key-row__select"
              type="button"
              :aria-pressed="selectedHandleId === key.handleId"
              :data-testid="`select-ssh-key-${key.handleId}`"
              @click="emit('select', key.handleId)"
            >
              <KeyIcon :size="18" />
              <span class="key-row__copy">
                <strong>{{ key.label }}</strong>
                <span class="key-row__details">{{ key.algorithm }}<span v-if="key.passphraseRequired"> {{ t('keys.needsPassphrase') }}</span></span>
                <code>{{ key.fingerprintSha256 }}</code>
              </span>
              <AppIcon v-if="selectedHandleId === key.handleId" name="check" :size="16" />
            </button>
            <button
              class="icon-button key-row__delete"
              type="button"
              :aria-label="t('keys.deleteAria', { label: key.label })"
              :data-testid="`delete-ssh-key-${key.handleId}`"
              @click="requestDelete(key)"
            ><AppIcon name="trash-2" /></button>
          </div>
          <button
            class="key-row__public-toggle"
            type="button"
            :aria-expanded="expandedHandleId === key.handleId"
            :aria-controls="`ssh-public-key-panel-${key.handleId}`"
            :data-testid="`toggle-ssh-public-key-${key.handleId}`"
            @click="togglePublicKey(key)"
          >
            <span>{{ t('keys.publicTitle') }}</span>
            <AppIcon :name="expandedHandleId === key.handleId ? 'chevron-up' : 'chevron-down'" :size="16" />
          </button>
          <section
            v-if="expandedHandleId === key.handleId"
            :id="`ssh-public-key-panel-${key.handleId}`"
            class="key-public"
            :data-testid="`ssh-public-key-panel-${key.handleId}`"
          >
            <p class="key-public__hint">{{ t('keys.publicHint', { path: t('keys.authorizedKeysPath') }) }}</p>
            <code v-if="publicLines[key.handleId]" class="key-public__line" :data-testid="`ssh-public-key-${key.handleId}`">{{ publicLines[key.handleId] }}</code>
            <p v-else-if="publicBusy" class="key-public__hint">{{ t('keys.readingPublic') }}</p>
            <template v-if="publicPassphraseNeeded === key.handleId">
              <label class="form-field key-field">
                <span>{{ t('keys.passphraseTitle') }}</span>
                <input v-model="publicPassphrase" :data-testid="`ssh-public-key-passphrase-${key.handleId}`" type="password" autocomplete="off" @focus="keepFieldVisible" />
              </label>
              <button class="small-action key-action" type="button" :disabled="publicBusy || !publicPassphrase" @click="loadPublicKey(key)">{{ t('keys.showPublic') }}</button>
            </template>
            <div v-if="publicLines[key.handleId]" class="key-public__actions">
              <button class="small-action key-action" type="button" :data-testid="`copy-ssh-public-key-${key.handleId}`" :disabled="publicBusy" @click="copyPublicKey(key)">{{ t('keys.copy') }}</button>
              <button class="small-action key-action" type="button" :data-testid="`share-ssh-public-key-${key.handleId}`" :disabled="publicBusy" @click="sharePublicKey(key)">{{ t('keys.share') }}</button>
              <button
                v-if="hostInstall"
                class="small-action key-action key-action--wide"
                type="button"
                :data-testid="`install-ssh-public-key-${key.handleId}`"
                :disabled="publicBusy"
                @click="requestInstall(key)"
              >{{ t('keys.installTo', { host: hostInstall.hostLabel }) }}</button>
            </div>
            <p v-if="publicLines[key.handleId] && !hostInstall" class="key-public__hint" :data-testid="`ssh-public-key-install-hint-${key.handleId}`">{{ t('keys.installHint') }}</p>
            <section v-if="hostInstall && pendingInstallHandleId === key.handleId" class="key-confirm" role="alertdialog" :aria-labelledby="`install-title-${key.handleId}`" data-testid="ssh-key-install-confirmation">
              <strong :id="`install-title-${key.handleId}`">{{ t('keys.installConfirm', { key: key.label, host: hostInstall.hostLabel }) }}</strong>
              <p>{{ t('keys.installBody', { path: t('keys.authorizedKeysPath') }) }}</p>
              <div class="key-actions">
                <button class="small-action key-action" type="button" data-testid="cancel-install-ssh-key" :disabled="publicBusy" @click="pendingInstallHandleId = ''">{{ t('keys.cancel') }}</button>
                <button class="small-action key-action key-install-confirm" type="button" data-testid="confirm-install-ssh-key" :disabled="publicBusy" @click="confirmInstall(key)">
                  {{ publicBusy ? t('keys.installing') : t('keys.installAction') }}
                </button>
              </div>
            </section>
            <p v-if="publicError" class="connection-message" role="alert" data-testid="ssh-public-key-error">{{ publicError }}</p>
            <p v-else-if="publicMessage" class="key-success" role="status" data-testid="ssh-public-key-message">{{ publicMessage }}</p>
          </section>
        </li>
      </ul>

      <section v-if="pendingDelete" class="key-confirm" role="alertdialog" aria-labelledby="key-delete-title" data-testid="ssh-key-delete-confirmation">
        <strong id="key-delete-title">{{ t('keys.deleteConfirm', { key: pendingDelete.key.label }) }}</strong>
        <p>{{ t('keys.deleteBody') }}</p>
        <ul>
          <li v-for="host in pendingDelete.result.affectedHosts" :key="host.hostId">{{ host.hostLabel }}</li>
        </ul>
        <div class="key-actions">
          <button class="small-action key-action" type="button" data-testid="cancel-delete-ssh-key" :disabled="busy" @click="cancelDelete">{{ t('keys.cancel') }}</button>
          <button class="small-action key-action key-delete-confirm" type="button" data-testid="confirm-delete-ssh-key" :disabled="busy" @click="confirmDelete">
            {{ busy ? t('keys.deleting') : t('keys.deleteAction') }}
          </button>
        </div>
      </section>
    </section>

    <section class="key-panel panel" :class="{ 'key-panel--first': keys.length === 0 }" aria-labelledby="ssh-key-add-title" data-testid="ssh-key-add-panel">
      <div class="panel-heading">
        <div>
          <h2 id="ssh-key-add-title">{{ t('keys.addTitle') }}</h2>
        </div>
      </div>
      <div class="key-tabs" role="tablist" :aria-label="t('keys.addAria')">
        <button type="button" role="tab" :aria-selected="action === 'paste'" data-testid="ssh-key-paste-tab" @click="chooseAction('paste')">{{ t('keys.tabPaste') }}</button>
        <button type="button" role="tab" :aria-selected="action === 'import'" data-testid="ssh-key-import-tab" @click="chooseAction('import')">{{ t('keys.tabImport') }}</button>
        <button type="button" role="tab" :aria-selected="action === 'generate'" data-testid="ssh-key-generate-tab" @click="chooseAction('generate')">{{ t('keys.tabGenerate') }}</button>
      </div>
      <template v-if="action === 'paste'">
        <label class="form-field key-field">
          <span>{{ t('keys.privateKey') }}</span>
          <textarea
            ref="pasteInput"
            class="key-paste"
            data-testid="ssh-key-paste-text"
            rows="6"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
            data-gramm="false"
            :placeholder="t('keys.pastePlaceholder')"
            @input="notePasteInput"
            @focus="keepFieldVisible"
          ></textarea>
        </label>
        <p class="key-helper">{{ t('keys.pasteHelper') }}</p>
      </template>
      <label class="form-field key-field">
        <span>{{ t('keys.label') }}</span>
        <input v-model="label" data-testid="ssh-key-label" autocomplete="off" maxlength="80" :placeholder="t('keys.labelPlaceholder')" @focus="keepFieldVisible" />
      </label>
      <template v-if="action === 'paste' || action === 'import'">
        <label class="form-field key-field">
          <span>{{ t('keys.passphraseOptional') }}</span>
          <input v-model="passphrase" data-testid="ssh-key-import-passphrase" type="password" autocomplete="off" @focus="keepFieldVisible" />
        </label>
      </template>
      <template v-if="action === 'paste'">
        <button class="action-button" type="button" data-testid="import-pasted-ssh-key" :disabled="busy || !pasteHasText" @click="importPastedKey">
          {{ busy ? t('keys.importing') : t('keys.importPaste') }}
        </button>
      </template>
      <template v-else-if="action === 'import'">
        <p class="key-helper">{{ t('keys.importFileHelper') }}</p>
        <button class="action-button" type="button" data-testid="import-ssh-key" :disabled="busy" @click="importKey">
          {{ busy ? t('keys.importing') : t('keys.importFile') }}
        </button>
      </template>
      <template v-else>
        <label class="form-field key-field">
          <span>{{ t('keys.algorithm') }}</span>
          <select v-model="algorithm" data-testid="ssh-key-algorithm">
            <option value="Ed25519">Ed25519</option>
            <option value="RSA-3072">RSA 3072</option>
          </select>
        </label>
        <p class="key-helper">{{ t('keys.generateHelper') }}</p>
        <button class="action-button" type="button" data-testid="generate-ssh-key" :disabled="busy" @click="generateKey">
          {{ busy ? t('keys.generating') : t('keys.generate', { algorithm }) }}
        </button>
      </template>
      <p v-if="error" class="connection-message" role="alert" data-testid="ssh-key-error">{{ error }}</p>
      <p v-else-if="message" class="key-success" role="status" data-testid="ssh-key-message">{{ message }}</p>
    </section>
  </main>
</template>

<style scoped>
.key-screen { display: grid; align-content: start; gap: var(--sp-4); }
.key-screen__intro { display: grid; gap: var(--sp-2); padding: var(--sp-1) var(--sp-1) 0; }
.key-screen__intro h1 { margin: 0; font-size: var(--fs-600); font-weight: var(--fw-semibold); line-height: var(--lh-600); }
.key-screen__intro > p:last-child { max-width: 54rem; margin: 0; color: var(--fg-secondary); font-size: var(--fs-300); line-height: 1.5; }
.key-panel { padding: var(--sp-4); }
.key-panel .panel-heading { align-items: center; margin-bottom: var(--sp-3); }
.key-panel .panel-heading h2 { margin: 0; font-size: var(--fs-500); font-weight: var(--fw-medium); }
.key-empty { display: flex; align-items: center; gap: var(--sp-3); border: 1px solid var(--border-soft); border-radius: var(--r-md); padding: var(--sp-4); color: var(--fg-secondary); }
.key-empty strong { color: var(--fg); font-size: var(--fs-300); font-weight: var(--fw-medium); }
.key-empty p { margin: var(--sp-1) 0 0; color: var(--fg-secondary); font-size: var(--fs-200); line-height: 1.45; }
.key-list { display: grid; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
.key-screen__intro { order: -2; }
.key-panel--first { order: -1; }
.key-row { display: grid; gap: var(--sp-1); border: 1px solid var(--border-soft); border-radius: var(--r-lg); background: var(--bg); padding: var(--sp-2); }
.key-row__main { display: grid; grid-template-columns: minmax(0, 1fr) 48px; align-items: center; gap: var(--sp-2); }
.key-row__public-toggle { display: flex; min-height: 48px; align-items: center; justify-content: space-between; gap: var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); padding: 0 var(--sp-3); color: var(--fg); font-size: var(--fs-200); font-weight: var(--fw-medium); text-align: left; }
.key-row__public-toggle[aria-expanded="true"] { border-color: var(--accent); color: var(--accent); }
.key-public { display: grid; gap: var(--sp-2); padding: var(--sp-2) var(--sp-1) var(--sp-1); }
.key-public__hint { margin: 0; color: var(--fg-secondary); font-size: var(--fs-200); line-height: 1.45; }
.key-public__hint code, .key-confirm code { font-family: var(--font-mono); color: var(--fg); }
.key-public__line { display: block; max-height: 9.5em; overflow: auto; border: 1px solid var(--border-strong); border-radius: var(--r-md); background: var(--surface-2); padding: var(--sp-2) var(--sp-3); color: var(--fg); font: var(--fs-100)/1.5 var(--font-mono); overflow-wrap: anywhere; user-select: text; }
.key-public__actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); }
.key-action { min-height: 48px; }
.key-action--wide { grid-column: 1 / -1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-color: var(--accent); color: var(--accent); }
.key-install-confirm { border-color: var(--accent); background: var(--accent); color: var(--bg); }
.key-row__select { display: flex; min-width: 0; min-height: 56px; align-items: center; gap: var(--sp-3); border: 0; border-radius: var(--r-md); background: transparent; padding: var(--sp-2); color: var(--fg-secondary); text-align: left; }
.key-row__select[aria-pressed="true"] { background: var(--state-selected); color: var(--accent); }
.key-row__copy { display: grid; min-width: 0; flex: 1 1 auto; gap: var(--sp-1); }
.key-row__copy strong { overflow: hidden; color: var(--fg); font-size: var(--fs-300); font-weight: var(--fw-medium); text-overflow: ellipsis; white-space: nowrap; }
.key-row__details { color: var(--fg-secondary); font-size: var(--fs-200); }
.key-row__copy code { overflow: hidden; color: var(--fg-muted); font: var(--fs-100)/var(--lh-100) var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.key-row__delete { width: 48px; height: 48px; color: var(--error); }
.key-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-1); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); padding: var(--sp-1); margin-bottom: var(--sp-3); }
.key-tabs button { min-height: 48px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--fg-secondary); font-size: var(--fs-300); font-weight: var(--fw-medium); }
.key-tabs button[aria-selected="true"] { background: var(--surface); color: var(--fg); box-shadow: inset 0 0 0 1px var(--border); }
.key-field { margin-bottom: var(--sp-3); }
.key-paste { min-height: 9.5em; font: var(--fs-100)/1.45 var(--font-mono) !important; white-space: pre; overflow-wrap: normal; }
.key-field input, .key-field select { min-height: 48px; border: 1px solid var(--border-strong); border-radius: var(--r-md); background: var(--bg); padding: 0 var(--sp-3); color: var(--fg); font: var(--fs-300)/1.4 var(--font-mono); }
.key-helper { margin: 0 0 var(--sp-3); color: var(--fg-secondary); font-size: var(--fs-200); line-height: 1.5; }
.key-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--sp-2); }
.key-confirm { margin-top: var(--sp-3); border: 1px solid var(--warning); border-radius: var(--r-md); background: var(--warning-soft); padding: var(--sp-3); }
.key-confirm > strong { color: var(--fg); font-size: var(--fs-300); }
.key-confirm p { margin: var(--sp-2) 0; color: var(--fg-secondary); font-size: var(--fs-200); line-height: 1.45; }
.key-confirm ul { display: grid; gap: var(--sp-1); margin: 0; padding-left: var(--sp-4); color: var(--fg); font-size: var(--fs-300); }
.key-delete-confirm { border-color: var(--error); color: var(--error); }
.key-success { margin: var(--sp-3) 0 0; color: var(--success); font-size: var(--fs-200); line-height: 1.45; }
.key-panel > .action-button { min-height: 48px; }
.key-empty svg { flex: 0 0 auto; color: var(--accent); }
</style>
