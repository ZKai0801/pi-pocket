<script setup lang="ts">
/**
 * One chat bubble (spec §8.6): the user's message right on the WeChat-green
 * self bubble, the assistant's left on the raised surface. Both kinds render
 * their text through `renderChatMarkdown` (raw HTML dropped, links as plain
 * text, the result allow-list sanitized) so pasted code becomes escaped mono
 * blocks instead of interpreted markup.
 */
import { computed } from 'vue';
import { renderChatMarkdown } from '../../chat/markdown';

const props = defineProps<{
  role: 'user' | 'assistant';
  text: string;
}>();

const html = computed(() => renderChatMarkdown(props.text));
</script>

<template>
  <div
    class="bubble"
    :class="role === 'user' ? 'bubble--self' : 'bubble--other'"
  >
    <div class="bubble__content" v-html="html" />
  </div>
</template>

<style scoped>
/* A bubble is a share of the screen, not of its own content: `max-width` is
   the one phone-width ratio the chat sets (78%), capped in px so a wide
   preview shell does not grow a chat column with it. `min-width: 0` lets the
   content box below shrink past its own min-content size — without it one
   long unbreakable line (a `pre` line, a URL) sets the bubble's floor and
   pushes the whole transcript wider than the viewport. */
.bubble {
  display: flex;
  min-width: 0;
  max-width: min(var(--chat-bubble-max-width, 78%), 480px);
  flex: 0 0 auto;
}

.bubble--self {
  align-self: flex-end;
}

.bubble--other {
  align-self: flex-start;
}

.bubble__content {
  /* `min-width: 0` is what makes the 78% cap hold: as a flex item this box's
     automatic minimum size is otherwise its min-content size, which a `pre`
     line or a long token inflates past the screen. `anywhere` (not
     `break-word`) also shrinks the min-content contribution itself, so long
     prose wraps instead of widening the bubble. */
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  border-radius: var(--r-lg);
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-400);
  line-height: 1.45;
}

.bubble--self .bubble__content {
  background: var(--bubble-self-bg);
  color: var(--bubble-self-fg);
}

.bubble--other .bubble__content {
  background: var(--bubble-other-bg);
  color: var(--bubble-other-fg);
}

/* Markdown inside the bubble: the sanitized subset only (p/br/em/strong/del/
   code/pre/lists/blockquote — no anchors, no images). */
.bubble__content :deep(p) {
  margin: 0 0 var(--sp-2);
}

.bubble__content :deep(p:last-child) {
  margin-bottom: 0;
}

.bubble__content :deep(strong) {
  font-weight: var(--fw-semibold);
}

.bubble__content :deep(blockquote) {
  margin: 0 0 var(--sp-2);
  padding-left: var(--sp-2);
  border-left: 2px solid var(--border-strong);
  color: var(--fg-secondary);
}

.bubble__content :deep(blockquote:last-child) {
  margin-bottom: 0;
}

.bubble__content :deep(ul),
.bubble__content :deep(ol) {
  margin: 0 0 var(--sp-2);
  padding-left: var(--sp-4);
}

.bubble__content :deep(ul:last-child),
.bubble__content :deep(ol:last-child) {
  margin-bottom: 0;
}

.bubble__content :deep(li) {
  margin: 0 0 2px;
}

.bubble__content :deep(code) {
  border-radius: var(--r-sm);
  background: var(--surface);
  padding: 1px 4px;
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-300);
  /* Inline code wraps rather than setting the bubble's floor. */
  overflow-wrap: anywhere;
}

/* A fenced block keeps its line structure and scrolls inside the bubble:
   capped at the bubble's width, it can no longer push the bubble (and with
   it the transcript) past the screen edge. */
.bubble__content :deep(pre) {
  margin: 0 0 var(--sp-2);
  max-width: 100%;
  overflow-x: auto;
  border-radius: var(--r-md);
  background: var(--surface);
  padding: var(--sp-2);
}

.bubble__content :deep(pre:last-child) {
  margin-bottom: 0;
}

.bubble__content :deep(pre code) {
  display: block;
  border-radius: 0;
  background: transparent;
  padding: 0;
  color: var(--fg);
  font-size: var(--fs-300);
  line-height: 1.4;
}
</style>
