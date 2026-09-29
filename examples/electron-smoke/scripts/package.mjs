// Packages the sample the way a consumer ships it: Electron's own binary renamed to the app, with the app code in
// resources/app.asar, archived as the file Release QA installs (a .zip on Windows, a .tar.gz on Linux).
//
//   node scripts/package.mjs
//
// The archive goes to out/release-qa-electron-smoke-<platform>.<ext>. Run write-candidate.mjs next to describe it.
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARCHIVES = { win32: ['win32', '.zip', ['-a', '-c', '-f']], linux: ['linux', '.tar.gz', ['-c', '-z', '-f']] };
const target = ARCHIVES[process.platform];
if (target === undefined) {
  console.error(`the sample has packages for Windows and Linux only, not ${process.platform}`);
  process.exit(1);
}
const [platform, extension, tarFlags] = target;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');
const NAME = 'release-qa-electron-smoke';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const [built] = await packager({
  dir: root,
  out,
  name: NAME,
  platform,
  arch: 'x64',
  asar: true,
  overwrite: true,
  prune: true,
  // Only the app itself ships; the harness files next to it do not.
  ignore: [/^\/(out|scripts|qa|README\.md|package-lock\.json)($|\/)/],
});
const archive = join(out, `${NAME}-${platform}${extension}`);
// bsdtar (Windows' tar.exe) picks zip from the .zip name with -a; GNU tar writes a gzip tarball. Windows' own tar is
// named by path, since a GNU tar earlier on PATH (Git for Windows) reads `C:` as a remote host. Entries are relative to
// the folder, so the archive unpacks into whatever directory it is given.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, [...tarFlags, archive, '-C', built, '.'], { stdio: 'inherit' });
console.log(archive);
