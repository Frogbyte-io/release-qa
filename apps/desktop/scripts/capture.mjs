// Runs the built app twice against recorded snapshots (fixtures/before.json, fixtures/after.json) and saves the window
// pixels to evidence/. Build first (`npm run build`). Nothing is read from GitHub.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const electron = createRequire(import.meta.url)('electron');
// This tool's own shells may set ELECTRON_RUN_AS_NODE, which would make Electron run as plain Node.
const { ELECTRON_RUN_AS_NODE: _ignored, ...environment } = process.env;

for (const name of ['before', 'after']) {
  const result = spawnSync(electron, [root], {
    stdio: 'inherit',
    timeout: 60_000,
    env: {
      ...environment,
      RELEASE_QA_DASHBOARD_FIXTURE: resolve(root, 'fixtures', `${name}.json`),
      RELEASE_QA_CAPTURE_DIR: resolve(root, 'evidence'),
      RELEASE_QA_CAPTURE_PREFIX: name,
    },
  });
  if (result.status !== 0) throw new Error(`capturing ${name} failed (exit ${result.status})`);
}
