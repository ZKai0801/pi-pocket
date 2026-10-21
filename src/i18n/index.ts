/**
 * The phone shell's language seam: one reactive locale, one `t()` lookup.
 *
 * Shaped like the theme seam next door (`src/phone/themeSync.ts`): the stored
 * choice lives in the phone settings store, this module owns only the
 * resolution and the lookup, and the shell applies the choice (here, to the
 * document's `lang` so the system font and spell-checkers agree).
 *
 * `t()` reads the locale ref, so a template that calls it re-renders when the
 * language changes and a `computed()` over it stays correct in script code.
 * A key missing from the active table falls back to `zh-CN` — the table the
 * app shipped with — and then to the key itself.
 */
import { ref } from 'vue';
import { MESSAGES, type MessageKey } from './messages';

export type UiLocale = 'zh-CN' | 'en';

/** The stored value that means "follow the device". */
export const UI_LANGUAGE_SYSTEM = 'system';

export type UiLanguage = UiLocale | typeof UI_LANGUAGE_SYSTEM;

/**
 * What shipped before languages existed: the screens are Chinese, so an
 * upgrade keeps them Chinese (the same contract as `THEME_CHOICE_DEFAULT`).
 */
export const UI_LANGUAGE_DEFAULT: UiLocale = 'zh-CN';

export const UI_LOCALES: readonly UiLocale[] = ['zh-CN', 'en'];

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === UI_LANGUAGE_SYSTEM || value === 'zh-CN' || value === 'en';
}

/** The settings store's parser: `system` or a known locale, else undefined. */
export function parseUiLanguage(value: unknown): UiLanguage | undefined {
  return isUiLanguage(value) ? value : undefined;
}

/** Anything unrecognised keeps Chinese, the same degradation the store uses. */
export function normalizeUiLanguage(value: unknown): UiLanguage {
  return parseUiLanguage(value) ?? UI_LANGUAGE_DEFAULT;
}

/**
 * What the device prefers, from `navigator.language`. Only the leading
 * subtag is read: `zh`, `zh-CN` and `zh-Hant-TW` all mean Chinese here, and
 * anything else falls to English rather than to an untranslated table.
 */
export function preferredLocale(): UiLocale {
  if (typeof navigator === 'undefined') return UI_LANGUAGE_DEFAULT;
  const tag = Array.isArray(navigator.languages) && navigator.languages.length > 0
    ? navigator.languages[0]
    : navigator.language;
  return typeof tag === 'string' && tag.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** The locale a stored choice means right now. */
export function resolveUiLanguage(language: UiLanguage): UiLocale {
  return language === UI_LANGUAGE_SYSTEM ? preferredLocale() : language;
}

const activeLocale = ref<UiLocale>(resolveUiLanguage(UI_LANGUAGE_DEFAULT));

/** The locale in force; read-only outside this module. */
export function uiLocale(): UiLocale {
  return activeLocale.value;
}

/**
 * Switch language: the lookup table and the document's `lang` together, so
 * Android's font fallback and IME follow the copy.
 */
export function applyUiLanguage(root: HTMLElement, language: UiLanguage): void {
  const locale = resolveUiLanguage(language);
  activeLocale.value = locale;
  root.lang = locale;
}

/** Fill `{name}` placeholders; a missing value leaves the placeholder put. */
function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const table = MESSAGES[activeLocale.value];
  const template = table[key] ?? MESSAGES['zh-CN'][key] ?? key;
  return params ? interpolate(template, params) : template;
}

/**
 * Re-resolve a `system` choice when the device's language changes (Android
 * fires `languagechange` on the window). Returns a disposer.
 */
export function watchSystemLanguage(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('languagechange', onChange);
  return () => window.removeEventListener('languagechange', onChange);
}
