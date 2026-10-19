/**
 * Chat markdown (spec §8.6): assistant text — and the user's own echoed text
 * — is remote content rendered inside a WebView, and `marked` does not
 * sanitize. `renderChatMarkdown` is the only path chat text takes to the DOM:
 *
 *   1. raw HTML is dropped at the `marked` token level (the `html` renderer
 *      emits nothing, so `<img>`, `<script>` and friends never reach the
 *      output at all);
 *   2. links render as their anchor text, plain: no `<a>`, no `href`, so a
 *      `javascript:` URL has nowhere to hide;
 *   3. the result still passes `DOMPurify.sanitize` with an explicit tag
 *      allow-list (no `a`, no `img`) as the second wall.
 *
 * Fenced code comes out as escaped `<pre><code>` — code is displayed, never
 * interpreted.
 */
import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

const marked = new Marked({ gfm: true });

marked.use({
  renderer: {
    // Raw HTML (block `<img …>`, inline `<b onclick>`, whole `<script>`s) is
    // untrusted remote content: drop it at the token level, before the
    // sanitizer ever sees it.
    html() {
      return '';
    },
    // Links render as text (spec §8.6): the anchor text only, no anchor
    // element, no href — auto-followed or not, the URL never reaches the DOM.
    link(token: Tokens.Link) {
      return token.text;
    },
  },
});

/** The only tags chat content may contain once it reaches the DOM. */
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'blockquote',
];

/** Markdown -> sanitized HTML for the chat bubbles. Never throws on odd input. */
export function renderChatMarkdown(src: string): string {
  const html = marked.parse(src, { async: false });
  return DOMPurify.sanitize(html, { ALLOWED_TAGS });
}
