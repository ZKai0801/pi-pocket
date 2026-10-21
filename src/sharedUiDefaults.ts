import { fontCssVariables } from '@ui/fonts';
import { resolveTheme, THEME_CHOICE_DEFAULT, type ThemeSpec } from '@ui/themes';

/** Android browser surfaces use the system monospace face as the safe fallback. */
export const mobileFontVariables = fontCssVariables(
  { monospaceFontFamily: null, terminalFontSize: 13, editorFontSize: 13 },
  'ui-monospace, monospace',
);
export const mobileMonoFontFamily = mobileFontVariables['--font-mono'];

/**
 * Write one theme record onto `root` — the `data-theme` hook, the
 * `color-scheme` the form controls and scrollbars read, and every colour
 * token. The same loop App.vue runs for the legacy screens; both shells
 * consume the one registry in `@ui/themes`.
 */
export function applyThemeTokens(root: HTMLElement, theme: ThemeSpec): void {
  root.dataset['theme'] = theme.id;
  root.style.colorScheme = theme.appearance;
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(name, value);
  }
}

/**
 * Apply shared theme data (a stored choice, defaulting to what ships) while
 * leaving phone layout and safe-area CSS local. The entry points call this
 * once for a correct first paint; the live switching on top of it is the
 * phone shell's `installThemeSync`.
 */
export function applySharedUiDefaults(
  root: HTMLElement,
  themeChoice: string = THEME_CHOICE_DEFAULT,
): void {
  applyThemeTokens(root, resolveTheme(themeChoice));
  for (const [name, value] of Object.entries(mobileFontVariables)) {
    root.style.setProperty(name, value);
  }
}
