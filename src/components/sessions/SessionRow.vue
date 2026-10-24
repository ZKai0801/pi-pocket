<script setup lang="ts">
/**
 * One 会话 row: the conversation's name, its time and a two-line preview,
 * with the pulse that says a turn is still running in it. Shared by the two
 * lists the tab shows — the selected project's conversations and the ones
 * recently opened on this host — because they are the same row; only where
 * the rows came from (and what the time means) differs.
 *
 * The row is also the tab's selection surface: a tap opens a conversation, a
 * long-press turns the list into a tick list, and inside that mode a tap
 * ticks the row instead. The long-press is a pointer timer rather than a
 * `contextmenu` handler because a phone's long-press must survive the finger
 * travelling a pixel or two and must never fire while the list is scrolling.
 * A conversation with a turn still in flight enters the mode but refuses the
 * tick: its file is pi's session on the host, not something to delete
 * underneath it.
 */
import { computed, onBeforeUnmount } from 'vue';
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
  /** The list is a tick list: a tap ticks this row instead of opening it. */
  selecting?: boolean;
  /** This row is ticked. */
  selected?: boolean;
}>();

const emit = defineEmits<{
  open: [path: string];
  'long-press': [path: string];
  toggle: [path: string];
}>();

/** Android's own feel: long enough that a flick past a row never arms it. */
const HOLD_MS = 500;
/** Past this much travel the gesture is a scroll, not a press. */
const HOLD_MOVE_TOLERANCE_PX = 10;

const deletable = computed(() => !props.running);

let holdTimer: ReturnType<typeof setTimeout> | null = null;
let holdOrigin: { x: number; y: number } | null = null;
/** The click that closes a long-press is the press ending, not a tap on the row. */
let suppressClick = false;

function cancelHold(): void {
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = null;
  holdOrigin = null;
}

function onPointerDown(event: PointerEvent): void {
  // A second finger, or the pen's barrel button, must not arm the hold.
  if (!event.isPrimary) return;
  cancelHold();
  suppressClick = false;
  holdOrigin = { x: event.clientX, y: event.clientY };
  holdTimer = setTimeout(() => {
    holdTimer = null;
    holdOrigin = null;
    suppressClick = true;
    emit('long-press', props.path);
  }, HOLD_MS);
}

function onPointerMove(event: PointerEvent): void {
  if (holdTimer === null || holdOrigin === null) return;
  const dx = event.clientX - holdOrigin.x;
  const dy = event.clientY - holdOrigin.y;
  if (Math.abs(dx) > HOLD_MOVE_TOLERANCE_PX || Math.abs(dy) > HOLD_MOVE_TOLERANCE_PX) cancelHold();
}

function onClick(): void {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (props.selecting === true) {
    emit('toggle', props.path);
    return;
  }
  emit('open', props.path);
}

onBeforeUnmount(cancelHold);
</script>

<template>
  <li
    class="sessions__row"
    :class="{ 'sessions__row--ticked': props.selecting === true && props.selected === true }"
    @contextmenu.prevent
  >
    <button
      type="button"
      class="sessions__item"
      :data-testid="`session-item-${props.path}`"
      :data-running="props.running ? 'true' : 'false'"
      :aria-pressed="props.selecting === true ? props.selected === true : undefined"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="cancelHold"
      @pointercancel="cancelHold"
      @lostpointercapture="cancelHold"
      @click="onClick"
    >
      <span
        v-if="props.selecting === true"
        class="sessions__check"
        :class="{
          'sessions__check--on': props.selected === true,
          'sessions__check--blocked': !deletable,
        }"
        data-testid="session-check"
        :data-selected="props.selected === true ? 'true' : 'false'"
        :data-blocked="deletable ? 'false' : 'true'"
        aria-hidden="true"
      >
        <AppIcon v-if="props.selected === true" name="check" class="sessions__check-glyph" />
      </span>
      <span
        v-else-if="props.running"
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
      <AppIcon v-if="props.selecting !== true" name="chevron-right" class="sessions__chevron" />
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

/* A ticked row is a claim about to be acted on, so it wears the accent
   softly rather than waiting for the delete to prove it. */
.sessions__row--ticked {
  background: var(--accent-soft);
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

/* The tick box: the same 20px slot the glyph keeps, so the rows do not shift
   when the list becomes a tick list. */
.sessions__check {
  display: inline-flex;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--on-accent);
  box-sizing: border-box;
}

.sessions__check--on {
  border-color: var(--accent);
  background: var(--accent);
}

/* Still visible, still untickable: the conversation has a turn running, and
   the reason is written in the confirm dialog rather than here. */
.sessions__check--blocked {
  opacity: var(--disabled-opacity);
}

.sessions__check-glyph {
  width: 14px;
  height: 14px;
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
