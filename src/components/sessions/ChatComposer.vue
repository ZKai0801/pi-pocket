<script setup lang="ts">
/**
 * The chat's composer (spec §7.4): multi-line text, tap to send, one turn at a
 * time. The text survives `'busy'` and `'error'` and is cleared only on
 * `'sent'`, so a failed send never loses what the user typed.
 */
import { computed, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';

const props = defineProps<{
  send: (text: string) => Promise<'sent' | 'busy' | 'error'>;
  sending: boolean;
  error: string | null;
}>();

const text = ref('');

const canSend = computed(() => !props.sending && text.value.trim().length > 0);

async function submit(): Promise<void> {
  if (!canSend.value) return;
  const draft = text.value;
  let result: 'sent' | 'busy' | 'error';
  try {
    result = await props.send(draft);
  } catch {
    result = 'error';
  }
  if (result === 'sent') text.value = '';
}
</script>

<template>
  <div class="composer">
    <p v-if="error" class="composer__error" role="alert" data-testid="chat-composer-error">
      {{ error }}
    </p>
    <div class="composer__row">
      <textarea
        v-model="text"
        class="composer__input"
        rows="1"
        placeholder="输入消息…"
        aria-label="输入消息"
        data-testid="chat-composer-input"
      />
      <button
        type="button"
        class="composer__send"
        aria-label="发送"
        data-testid="chat-composer-send"
        :disabled="!canSend"
        @click="submit"
      >
        <span v-if="sending" class="composer__spinner" data-testid="chat-composer-spinner">
          <AppIcon name="refresh" />
        </span>
        <span v-else>发送</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}

.composer__error {
  margin: 0;
  border: 1px solid var(--error);
  border-radius: var(--r-md);
  background: var(--error-soft);
  padding: var(--sp-2);
  color: var(--error);
  font-size: var(--fs-200);
  line-height: 1.45;
}

.composer__row {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
}

.composer__input {
  min-height: 48px;
  max-height: 120px;
  flex: 1 1 auto;
  resize: none;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  padding: var(--sp-2);
  color: var(--fg);
  font: var(--fs-300) var(--font-ui);
  line-height: 1.45;
  outline: none;
}

.composer__input::placeholder {
  color: var(--fg-muted);
}

.composer__input:focus-visible,
.composer__send:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.composer__send {
  display: inline-flex;
  width: 48px;
  height: 48px;
  min-width: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent);
  color: var(--on-accent);
  font: var(--fw-medium) var(--fs-300) var(--font-ui);
}

.composer__send:disabled {
  opacity: var(--disabled-opacity);
}

.composer__spinner {
  display: inline-flex;
  width: 20px;
  height: 20px;
  animation: composer-spin var(--dur-normal) linear infinite;
}

@keyframes composer-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
