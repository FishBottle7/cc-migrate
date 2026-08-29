/// <reference types="vite/client" />

import type { DesktopApi } from '../shared/api.js';

declare global {
  interface Window {
    api: DesktopApi;
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<Record<string, never>, Record<string, never>, any>;
  export default component;
}

export {};
