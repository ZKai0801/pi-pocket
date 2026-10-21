import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { bridgeWarmUp } from './native/bridgeReady';
import { durableStorageOpenCalls, installAndroidDurableStorage, recordDurableStorageStatus } from './native/durableStorage';
import { applySharedUiDefaults } from './sharedUiDefaults';
import { installAndroidPlatformServices } from './platform/androidPlatformServices';
import '@ui/styles.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

/**
 * The Android entry: bridge warm-up (#3000), the bounded durable-storage
 * hydrate (#2993), then the one phone shell (#2936, D42).
 *
 * `PhoneApp.vue` (and the stores it imports) is a lazy chunk loaded only AFTER
 * the install: those stores read saved data from `localStorage` at import
 * time, so they must see the durable, hydrated storage rather than the raw
 * WebView one.
 */
async function boot(): Promise<void> {
  // The page's first native call must be the sacrificial bridge ping: after a
  // reload Capacitor can hand the first reply to the previous document (see
  // BridgeReadyPlugin.java, #3000). Every later call, durable storage
  // included, uses this page's own channel.
  const bridge = await bridgeWarmUp();
  document.documentElement.dataset.bridgeWarmUp = JSON.stringify({ attempts: bridge.attempts, answered: bridge.answered });
  // Issue #2993: hydrate and make localStorage durable before any store reads
  // it. The open is bounded, so a lost reply records a failure instead of
  // leaving a blank screen.
  recordDurableStorageStatus(document.documentElement, await installAndroidDurableStorage());
  document.documentElement.dataset.durableStorageOpenCalls = String(durableStorageOpenCalls());

  // The saved theme goes on before the shell chunk loads, so the first frame
  // carries the user's palette rather than flashing the shipped dark one. The
  // shell's own `installThemeSync` keeps it live from here.
  const { readAppSettings } = await import('./stores/appSettings');
  const saved = readAppSettings();
  applySharedUiDefaults(document.documentElement, saved.themeChoice);
  // Same reason for the language: the first frame speaks the saved one.
  const { applyUiLanguage, normalizeUiLanguage } = await import('./i18n');
  applyUiLanguage(document.documentElement, normalizeUiLanguage(saved.uiLanguage));
  const { default: PhoneApp } = await import('./phone/PhoneApp.vue');
  const app = createApp(PhoneApp);
  // Settings → Diagnostics/About/Update services and launch-time error capture (#2861).
  installAndroidPlatformServices(app, window);
  app.use(createPinia()).mount('#app');
}

void boot();
