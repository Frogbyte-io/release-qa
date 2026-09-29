// Copies the packaged sample (from `npm run package` in examples/electron-smoke) to output/app, and a second copy to
// output/app-hardened with the fuses a security-conscious consumer typically turns off. Prints both executables.
//
//   node prepare.mjs
import { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { here } from './lib.mjs';

const platform = process.platform === 'win32' ? 'win32' : 'linux';
const packaged = join(here, '..', '..', 'examples', 'electron-smoke', 'out', `release-qa-electron-smoke-${platform}-x64`);
if (!existsSync(packaged)) {
  console.error(`${packaged} does not exist: run \`npm ci && npm run package\` in examples/electron-smoke first`);
  process.exit(1);
}
const exe = process.platform === 'win32' ? 'release-qa-electron-smoke.exe' : 'release-qa-electron-smoke';
const output = join(here, 'output');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const dir of ['app', 'app-hardened']) cpSync(packaged, join(output, dir), { recursive: true });

const hardened = join(output, 'app-hardened', exe);
await flipFuses(hardened, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
});
console.log(join(output, 'app', exe));
console.log(hardened);
console.log(JSON.stringify(await getCurrentFuseWire(hardened)));
