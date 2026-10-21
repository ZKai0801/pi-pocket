/**
 * The phone shell's live theme sync.
 *
 * The legacy screens re-resolve their tokens from App.vue's `watchEffect`;
 * this shell applies the same theme records reactively from the phone
 * settings store (`pocketshell.js.settings.v1`), and keeps Android's
 * system-bar icon polarity in step with the resolved appearance.
 */
import { watchEffect, type WatchStopHandle } from 'vue';
import { resolveTheme } from '@ui/themes';
import { applyThemeTokens } from '../sharedUiDefaults';
import { useAppSettings } from '../stores/appSettings';
import { applySystemBarsStyle } from '../native/systemBars';

/**
 * Track the stored theme choice onto `root` until the disposer runs. The
 * effect reads the choice and — through `resolveTheme` — the live
 * system-preference ref, so both a re-pick in 设置 and an OS dark-mode flip
 * while the choice is `system` re-run it.
 */
export function installThemeSync(root: HTMLElement): () => void {
  const settings = useAppSettings();
  const stop: WatchStopHandle = watchEffect(() => {
    const theme = resolveTheme(settings.themeChoice);
    applyThemeTokens(root, theme);
    // Best effort: the bars are chrome, never a reason to fail the theme.
    applySystemBarsStyle(theme.appearance).catch(() => undefined);
  });
  return stop;
}
