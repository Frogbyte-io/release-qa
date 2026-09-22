import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const run = promisify(execFile);
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// The CLI has no build step: Node (22.18 or newer) runs the TypeScript directly by stripping types. That only works
// while the source uses erasable syntax alone (no enums, namespaces or constructor parameter properties), which the
// `erasableSyntaxOnly` compiler option enforces. The floor of 22.18 is when stripping became default and silent.
test('the package loads under Node type stripping, so the CLI needs no build, and it prints no warning', async () => {
  const { stdout, stderr } = await run(
    process.execPath,
    ['-e', "import('./src/index.ts').then((m) => console.log(typeof m.executeScenario + ' ' + typeof m.evaluate + ' ' + typeof m.renderReport))"],
    { cwd: packageDir },
  );
  expect(stdout.trim()).toBe('function function function');
  expect(stderr).toBe('');
});
