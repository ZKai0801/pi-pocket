<script setup lang="ts">
/**
 * One 会话 row: the conversation's name, its time and a two-line preview,
 * with the pulse that says a turn is still running in it. Shared by the two
 * lists the tab shows — the selected project's conversations and the ones
 * recently opened on this host — because they are the same row; only where
 * the rows came from (and what the time means) differs.
 */
import AppIcon from '@ui/components/AppIcon.vue';
import { relativeTime } from '../../stores/sessions';
import { t } from '../../i18n';

const props = defineProps<{
  /** The session file's path: the row's identity, and what a tap opens. */
  path: string;
  /** The conversation's name, or its id when the file has no name yet. */
  title: string;
  /** The conversation's last line, when it has one. */
  preview: string | null;
  /** What the row's time means: the file's last update, or when it was opened. */
  whenMs: number;
  /** The conversation has a turn running — possibly in the background. */
  running: boolean;
}>();

const emit = defineEmits<{
  open: [path: string];
}>();
</script>

<template>
  <li class="sessions__row">
    <button type="button" class="sessions__item" @click="emit('open', props.path)">
      <span
        v-if="props.running"
        class="sessions__pulse"
        data-testid="session-running"
        :data-running="props.path"
        role="img"
        :aria-label="t('sessions.running')"
      >
        <AppIcon name="activity" class="sessions__glyph sessions__glyph--running" />
      </span>
      <AppIcon v-else name="activity" class="sessions__glyph" />
      <span class="sessions__text">
        <span class="sessions__head">
          <span class="sessions__name">{{ props.title }}</span>
          <span class="sessions__when">{{ relativeTime(props.whenMs) }}</span>
        </span>
        <span class="sessions__preview">{{ props.preview ?? t('sessions.noPreview') }}</span>
      </span>
      <AppIcon name="chevron-right" class="sessions__chevron" />
    </button>
  </li>
</template>

<style scoped>
.sessions__row {
  border-bottom: 1px solid var(--border-soft);
}

.sessions__row:last-child {
  border-bottom: 0;
}

.sessions__item {
  display: flex;
  width: 100%;
  min-height: 56px;
  align-items: center;
  gap: var(--sp-3);
  border: 0;
  background: transparent;
  padding: var(--sp-3) var(--sp-3);
  text-align: left;
}

.sessions__item:active {
  background: var(--state-hover);
}

.sessions__item:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}

.sessions__glyph {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  color: var(--accent);
}

/* A running conversation's glyph beats in place: the row keeps its alignment,
   and the motion is the only difference from a finished one. */
.sessions__pulse {
  display: inline-flex;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  animation: sessions-pulse 1.4s ease-in-out infinite;
}

.sessions__glyph--running {
  width: 20px;
  height: 20px;
}

@keyframes sessions-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.55;
    transform: scale(0.86);
  }
}

/* Reduced motion: a static accent ring instead of the beat. */
@media (prefers-reduced-motion: reduce) {
  .sessions__pulse {
    border: 2px solid var(--accent);
    animation: none;
  }
}

.sessions__text {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
}

.sessions__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
}

.sessions__name {
  overflow: hidden;
  flex: 1 1 auto;
  color: var(--fg);
  font-size: var(--fs-400);
  font-weight: var(--fw-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sessions__when {
  flex: 0 0 auto;
  color: var(--fg-muted);
  font-size: var(--fs-200);
}

.sessions__preview {
  display: -webkit-box;
  overflow: hidden;
  color: var(--fg-secondary);
  font-size: var(--fs-300);
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  word-break: break-word;
}

.sessions__chevron {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--fg-muted);
}
</style>
