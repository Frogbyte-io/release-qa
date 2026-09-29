// A script file (no imports), so the wildcard module declaration below is ambient.
interface Window {
  qa: import('../shared/contract.ts').QaBridge;
}

declare module '*.css';

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
