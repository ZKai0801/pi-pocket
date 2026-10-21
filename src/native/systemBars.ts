import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';

/**
 * Android's system-bar icon polarity follows the app theme.
 *
 * The bars' ground is the app's own background: Capacitor 8 runs the WebView
 * edge-to-edge (targetSdk 35 enforces it) and the document's `--bg` paints
 * behind both bars, so a theme switch already recolours them — only the icon
 * tint needs a native call, and the bundled core SystemBars plugin owns it.
 *
 * The naming inversion is the platform's, not ours: `Style.Light` asks for
 * dark icons on a light bar, `Style.Dark` for light icons on a dark bar.
 */
export async function applySystemBarsStyle(appearance: 'dark' | 'light'): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  await SystemBars.setStyle({
    style: appearance === 'light' ? SystemBarsStyle.Light : SystemBarsStyle.Dark,
  });
}
