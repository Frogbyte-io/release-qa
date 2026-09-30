// Builds the three parts of the app into dist/: the privileged main process, the sandboxed preload, and the renderer.
import vue from '@vitejs/plugin-vue';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
rmSync(resolve(root, 'dist'), { recursive: true, force: true });

// Main is bundled with the shared package (a workspace link, not a published dependency); Electron itself stays external.
await build({
  root,
  configFile: false,
  logLevel: 'warn',
  ssr: { noExternal: ['@frogbyte-io/release-qa'], external: ['electron'] },
  build: {
    ssr: 'src/main/index.ts',
    outDir: 'dist/main',
    emptyOutDir: true,
    target: 'node24',
    rollupOptions: { output: { format: 'es', entryFileNames: 'index.mjs' } },
  },
});

// The consumer's scenario and lifecycle code runs in a child process the shared runner forks. From a bundle that file is
// not next to the runner, so it is built here on its own and the main process names it (see `consumerWorker`).
await build({
  root,
  configFile: false,
  logLevel: 'warn',
  ssr: { noExternal: ['@frogbyte-io/release-qa'], external: ['electron'] },
  build: {
    ssr: resolve(root, '../../packages/qa/src/cli/consumer-worker.ts'),
    outDir: 'dist/main',
    emptyOutDir: false,
    target: 'node24',
    rollupOptions: { output: { format: 'es', entryFileNames: 'consumer-worker.mjs' } },
  },
});

// A sandboxed preload is a CommonJS script that may load only Electron.
await build({
  root,
  configFile: false,
  logLevel: 'warn',
  ssr: { noExternal: true, external: ['electron'] },
  build: {
    ssr: 'src/preload/index.ts',
    outDir: 'dist/preload',
    emptyOutDir: true,
    target: 'node24',
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
  },
});

await build({
  root: resolve(root, 'src/renderer'),
  configFile: false,
  logLevel: 'warn',
  base: './',
  plugins: [vue()],
  build: { outDir: resolve(root, 'dist/renderer'), emptyOutDir: true },
});
