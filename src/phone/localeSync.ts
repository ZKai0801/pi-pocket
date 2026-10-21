/**
 * The phone shell's live language sync — the counterpart to `themeSync.ts`.
 *
 * The stored choice is `system` or a locale id; the effect re-resolves it on
 * every change, and also when the device's own language flips while the
 * choice is `system` (Android fires `languagechange` on the window).
 */
import { watchEffect, type WatchStopHandle } from 'vue';
import { applyUiLanguage, normalizeUiLanguage, watchSystemLanguage } from '../i18n';
import { useAppSettings } from '../stores/appSettings';

export function installLocaleSync(root: HTMLElement): () => void {
  const settings = useAppSettings();
  const apply = () => applyUiLanguage(root, normalizeUiLanguage(settings.uiLanguage));
  const stopSystemLanguage = watchSystemLanguage(apply);
  const stop: WatchStopHandle = watchEffect(apply);
  return () => {
    stopSystemLanguage();
    stop();
  };
}
