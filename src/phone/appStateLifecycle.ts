/**
 * Binds `@capacitor/app`'s `appStateChange` to the kept background-grace owner
 * (`src/session/appLifecycle.ts`, spec §6.2): backgrounding enters grace and
 * returning reconnects. Kept separate from `PhoneApp.vue` so the wiring is
 * testable with a fake listener.
 */
import { createAppLifecycleHandler, type AppLifecycleController } from '../session/appLifecycle';

export interface AppStateListenerSource {
  addListener(
    event: 'appStateChange',
    listener: (state: { isActive: boolean }) => void,
  ): Promise<{ remove(): void }>;
}

export interface AppStateLifecycleOptions {
  app: AppStateListenerSource;
  getController: () => AppLifecycleController | null;
  getBackgroundGraceMs: () => number;
  getReconnectOnReturn: () => boolean;
  onError: (error: unknown) => void;
}

/** Register the listener; the returned disposer removes it. */
export function installAppStateLifecycle(options: AppStateLifecycleOptions): () => void {
  const handle = createAppLifecycleHandler({
    getController: options.getController,
    getBackgroundGraceMs: options.getBackgroundGraceMs,
    getReconnectOnReturn: options.getReconnectOnReturn,
    onError: options.onError,
  });
  let disposed = false;
  let remove: (() => void) | undefined;
  void options.app
    .addListener('appStateChange', ({ isActive }) => handle(isActive))
    .then((listener) => {
      if (disposed) void listener.remove();
      else remove = () => { void listener.remove(); };
    })
    .catch(options.onError);
  return () => {
    disposed = true;
    remove?.();
  };
}
