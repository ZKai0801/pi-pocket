import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import phoneAppSource from '../../src/phone/PhoneApp.vue?raw';
import tabBarSource from '../../src/components/shell/AppTabBar.vue?raw';
import settingsTabSource from '../../src/components/settings/SettingsTab.vue?raw';

/** The entry keeps its reads in .ts files; everything here is shell wiring. */
function tsSource(relative: string): string {
  return readFileSync(new URL(`../../src/${relative}`, import.meta.url), 'utf8');
}

describe('settings tab and live theme', () => {
  it('adds 设置 as the tab bar\'s fourth peer root, labelled through the copy table', () => {
    expect(tabBarSource).toContain("'connections' | 'projects' | 'sessions' | 'settings'");
    expect(tabBarSource).toContain("{ id: 'settings', label: t('tab.settings'), icon: 'settings' }");
    // Labels are copy, so they follow 设置 → 语言 without a rebuild.
    expect(tabBarSource).toContain("import { t } from '../../i18n'");
  });

  it('renders the settings tab from the shell and keeps Back at its root a minimize', () => {
    expect(phoneAppSource).toContain('<SettingsTab v-show="activeTab === \'settings\'" />');
    expect(phoneAppSource).toContain("settings: 'connection'");
  });

  it('picks the theme from the shared registry through the phone settings store', () => {
    expect(settingsTabSource).toContain("import { THEME_CHOICE_SYSTEM, THEMES } from '@ui/themes'");
    expect(settingsTabSource).toContain(':value="settings.themeChoice"');
    expect(settingsTabSource).toContain('settings.setThemeChoice(');
    // The choice persists in pocketshell.js.settings.v1; the store's parser
    // degrades unknown ids to the default (covered by appSettings.test.ts).
    expect(settingsTabSource).toContain('data-testid="setting-theme-choice"');
  });

  it('picks the interface language from the same screen and applies it live', () => {
    expect(settingsTabSource).toContain(':value="settings.uiLanguage"');
    expect(settingsTabSource).toContain('settings.setUiLanguage(');
    expect(settingsTabSource).toContain('data-testid="setting-ui-language"');
    // 跟随系统 translates; the two locales keep their own names.
    expect(settingsTabSource).toContain("t('settings.language.zh-CN')");
    expect(settingsTabSource).toContain("t('settings.language.en')");
    const localeSync = tsSource('phone/localeSync.ts');
    expect(localeSync).toContain('applyUiLanguage(root, normalizeUiLanguage(settings.uiLanguage))');
    expect(phoneAppSource).toContain('installLocaleSync(document.documentElement)');
  });

  it('keeps every locale complete: an English entry for every Chinese one', () => {
    const messages = tsSource('i18n/messages.ts');
    const zhKeys = [...messages.matchAll(/^ {2}'([a-z][\w.-]*)':\s*'/gm)].map((match) => match[1]);
    expect(zhKeys.length).toBeGreaterThan(100);
    for (const key of zhKeys) {
      expect(messages, `messages.ts has no English entry for ${key}`).toContain(`'${key}': '`);
    }
  });

  it('applies the resolved theme live and follows it with the system-bar icons', () => {
    const themeSync = tsSource('phone/themeSync.ts');
    expect(themeSync).toContain('watchEffect(');
    expect(themeSync).toContain('resolveTheme(settings.themeChoice)');
    expect(themeSync).toContain('applyThemeTokens(root, theme)');
    expect(themeSync).toContain('applySystemBarsStyle(theme.appearance)');
    expect(phoneAppSource).toContain('installThemeSync(document.documentElement)');
  });

  it('paints the saved theme before the shell chunk loads, so the first frame has no dark flash', () => {
    const main = tsSource('main.ts');
    const install = main.indexOf('await installAndroidDurableStorage()');
    const settings = main.indexOf("await import('./stores/appSettings')");
    const phoneApp = main.indexOf("await import('./phone/PhoneApp.vue')");
    expect(install).toBeGreaterThan(-1);
    expect(settings).toBeGreaterThan(install);
    expect(phoneApp).toBeGreaterThan(settings);
    expect(main).toContain('readAppSettings()');
    expect(main).toContain('applySharedUiDefaults(document.documentElement, saved.themeChoice)');
    expect(main).toContain('applyUiLanguage(document.documentElement, normalizeUiLanguage(saved.uiLanguage))');
  });
});
