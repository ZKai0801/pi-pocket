<script setup lang="ts">
/**
 * The chat's composer (spec §7.4): multi-line text, tap to send. The text
 * survives `'busy'` and `'error'` and is cleared only on `'sent'`, so a failed
 * send never loses what the user typed.
 *
 * While the open chat is running the composer does not close: the same button
 * becomes 插话 (steering — pi delivers it at the next turn boundary, inside the
 * work already under way) and a second 排队 button appears for a follow-up,
 * which pi only delivers once the run has nothing left to do. That difference
 * is the whole point of having two buttons, so the copy never says "send" for
 * either.
 */
import { computed, ref } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import { t } from '../../i18n';

const props = defineProps<{
  send: (text: string, intent?: 'steer' | 'follow-up') => Promise<'sent' | 'busy' | 'error'>;
  sending: boolean;
  error: string | null;
  /** The open chat's conversation has a turn in flight. */
  running: boolean;
}>();

const text = ref('');

const canSend = computed(() => !props.sending && text.value.trim().length > 0);

async function submit(intent?: 'steer' | 'follow-up'): Promise<void> {
  if (!canSend.value) return;
  const draft = text.value;
  let result: 'sent' | 'busy' | 'error';
  try {
    result = await props.send(draft, intent);
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
        :placeholder="t('composer.placeholder')"
        :aria-label="t('composer.aria')"
        data-testid="chat-composer-input"
      />
      <button
        v-if="running"
        type="button"
        class="composer__queue"
        :aria-label="t('composer.followUpAria')"
        data-testid="chat-composer-follow-up"
        :disabled="!canSend"
        @click="submit('follow-up')"
      >
        {{ t('composer.followUp') }}
      </button>
      <button
        type="button"
        class="composer__send"
        :aria-label="running ? t('composer.steerAria') : t('composer.send')"
        data-testid="chat-composer-send"
        :data-intent="running ? 'steer' : 'send'"
        :disabled="!canSend"
        @click="submit(running ? 'steer' : undefined)"
      >
        <span v-if="sending" class="composer__spinner" data-testid="chat-composer-spinner">
          <AppIcon name="refresh" />
        </span>
        <span v-else>{{ running ? t('composer.steer') : t('composer.send') }}</span>
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
  /* `min-width: 0`: the textarea's intrinsic `cols` width is a flex floor,
     and the row must fit the send button beside it on a narrow phone. */
  min-width: 0;
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
.composer__send:focus-visible,
.composer__queue:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.composer__send {
  display: inline-flex;
  /* Auto width so the label （发送/插话/Steer/Queue） fits: a fixed 48 px
     clipped the longer English words. */
  min-width: 48px;
  height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent);
  padding: 0 var(--sp-3);
  color: var(--on-accent);
  font: var(--fw-medium) var(--fs-300) var(--font-ui);
  white-space: nowrap;
}

/* A follow-up is the quieter of the two: it does nothing until the whole run
   is done, so it must not compete with 插话 for the thumb. */
.composer__queue {
  display: inline-flex;
  min-width: 48px;
  height: 48px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  padding: 0 var(--sp-2);
  color: var(--fg-secondary);
  font: var(--fw-medium) var(--fs-300) var(--font-ui);
}

.composer__queue:active {
  background: var(--state-hover);
}

.composer__send:disabled,
.composer__queue:disabled {
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
