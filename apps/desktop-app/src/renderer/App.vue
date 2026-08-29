<script setup lang="ts">
import { MigrateWizard } from '@session-migrate/ui';
import type { MigrationBackend } from '@session-migrate/ui/types';

// preload 注入的 window.api 实现了 MigrationBackend 契约
const backend = window.api as MigrationBackend;
</script>

<template>
  <div class="app">
    <MigrateWizard class="app-wizard" :backend="backend" />
  </div>
</template>

<style>
/* 全局基底：白纸画布 + 两团极淡的紫晕环境光 + 细颗粒噪点 */
html,
body,
#app {
  height: 100%;
  margin: 0;
}
body {
  background: var(--ink-0, #ffffff);
  color: var(--fg-0, #262038);
  font-family: var(--sans, system-ui, "Segoe UI", "Microsoft YaHei UI", sans-serif);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  overflow: hidden;
}
.app {
  position: relative;
  height: 100%;
}
/* 环境光 */
.app::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background:
    radial-gradient(900px 480px at 78% -12%, rgba(118, 99, 224, 0.055), transparent 62%),
    radial-gradient(720px 420px at -8% 108%, rgba(167, 141, 245, 0.045), transparent 60%);
  z-index: 0;
}
/* 细颗粒 */
.app::after {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: 0.016;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  z-index: 0;
}
.app-wizard {
  position: relative;
  z-index: 1;
  height: 100%;
}
</style>
