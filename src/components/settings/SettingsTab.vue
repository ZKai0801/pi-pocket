<script setup lang="ts">
/**
 * 设置 (tab 4, spec §8.1's fourth peer root): where the phone's own
 * preferences live. The theme picker is the first entry — it writes the same
 * `pocketshell.js.settings.v1` choice the shared theme registry
 * (`@ui/themes`) resolves, which the shell's `installThemeSync` applies live
 * to the document and to Android's system bars.
 */
import { THEME_CHOICE_SYSTEM, THEMES } from '@ui/themes';
import { useAppSettings } from '../../stores/appSettings';

const settings = useAppSettings();

function setThemeChoice(event: Event) {
  settings.setThemeChoice((event.target as HTMLSelectElement).value);
}
</script>

<template>
  <main class="screen-content settings-screen" data-testid="settings-tab">
    <section class="panel settings-panel" aria-labelledby="settings-tab-title">
      <h1 id="settings-tab-title">设置</h1>
      <p class="settings-copy">选择 PocketShell 的外观。</p>

      <label class="settings-control">
        <span><strong>主题</strong><small>同时作用于界面和 SSH 终端的配色。</small></span>
        <select :value="settings.themeChoice" data-testid="setting-theme-choice" @change="setThemeChoice">
          <option :value="THEME_CHOICE_SYSTEM">跟随系统</option>
          <option v-for="theme in THEMES" :key="theme.id" :value="theme.id">{{ theme.label }}</option>
        </select>
      </label>
      <p class="settings-note">选择「跟随系统」时，配色会随系统的深色模式自动切换；其余主题立即生效并保存。</p>
    </section>
  </main>
</template>
