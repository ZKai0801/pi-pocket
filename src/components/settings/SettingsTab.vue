<script setup lang="ts">
/**
 * 设置 (tab 4, spec §8.1's fourth peer root): where the phone's own
 * preferences live. The theme and language pickers are the first entries —
 * they write the same `pocketshell.js.settings.v1` choices the shell applies
 * live through `installThemeSync` and `installLocaleSync`.
 */
import { computed } from 'vue';
import { THEME_CHOICE_SYSTEM, THEMES } from '@ui/themes';
import { t, UI_LANGUAGE_SYSTEM } from '../../i18n';
import { useAppSettings } from '../../stores/appSettings';

const settings = useAppSettings();

/** 跟随系统 is copy (it translates); the two locales wear their own names. */
const languageOptions = computed(() => [
  { code: UI_LANGUAGE_SYSTEM, label: t('settings.languageSystem') },
  { code: 'zh-CN', label: t('settings.language.zh-CN') },
  { code: 'en', label: t('settings.language.en') },
]);

function setThemeChoice(event: Event) {
  settings.setThemeChoice((event.target as HTMLSelectElement).value);
}

function setUiLanguage(event: Event) {
  settings.setUiLanguage((event.target as HTMLSelectElement).value);
}
</script>

<template>
  <main class="screen-content settings-screen" data-testid="settings-tab">
    <section class="panel settings-panel" aria-labelledby="settings-tab-title">
      <h1 id="settings-tab-title">{{ t('settings.title') }}</h1>
      <p class="settings-copy">{{ t('settings.copy') }}</p>

      <label class="settings-control">
        <span><strong>{{ t('settings.theme') }}</strong><small>{{ t('settings.themeHint') }}</small></span>
        <select :value="settings.themeChoice" data-testid="setting-theme-choice" @change="setThemeChoice">
          <option :value="THEME_CHOICE_SYSTEM">{{ t('settings.themeSystem') }}</option>
          <option v-for="theme in THEMES" :key="theme.id" :value="theme.id">{{ theme.label }}</option>
        </select>
      </label>
      <p class="settings-note">{{ t('settings.themeNote') }}</p>

      <label class="settings-control">
        <span><strong>{{ t('settings.language') }}</strong><small>{{ t('settings.languageHint') }}</small></span>
        <select :value="settings.uiLanguage" data-testid="setting-ui-language" @change="setUiLanguage">
          <option v-for="option in languageOptions" :key="option.code" :value="option.code">{{ option.label }}</option>
        </select>
      </label>
      <p class="settings-note">{{ t('settings.languageNote') }}</p>

      <h2 class="settings-section">{{ t('settings.connectionsSection') }}</h2>
      <p class="settings-note">{{ t('settings.autoReconnectNote') }}</p>
      <p class="settings-note">{{ t('settings.launchReconnectNote') }}</p>
    </section>
  </main>
</template>
