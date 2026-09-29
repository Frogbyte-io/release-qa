// Writes a local candidate manifest for the package this machine just built: the .zip on Windows, the .tar.gz on
// Linux. It hashes the file as it is now; package again and you have a new candidate, so run this again.
//
//   node scripts/write-candidate.mjs [id]
//
// The manifest goes next to the archive (out/candidate.json), because a manifest may only name files in or under its
// own directory. Its path is printed for `release-qa run --candidate`.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILES = { win32: ['windows', '.zip'], linux: ['linux', '.tar.gz'] };
// The id grammar the runner accepts (see packages/qa/src/model/validate.ts).
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const platform = PROFILES[process.platform];
if (platform === undefined) {
  console.error(`the sample has profiles for Windows and Linux only, not ${process.platform}`);
  process.exit(1);
}
const [profile, extension] = platform;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');

const files = readdirSync(out).filter((name) => name.endsWith(extension));
if (files.length !== 1) {
  console.error(`expected exactly one ${extension} in ${out}, found ${files.length}: package the sample first (npm run package)`);
  process.exit(1);
}
const [name] = files;
const sha256 = createHash('sha256').update(readFileSync(join(out, name))).digest('hex');
const id = process.argv[2] ?? `local-${profile}-${sha256.slice(0, 12)}`;
if (!ID.test(id)) {
  console.error(`${JSON.stringify(id)} is not a valid candidate id: letters, digits, ".", "_" or "-", starting with a letter or digit`);
  process.exit(1);
}
const path = join(out, 'candidate.json');
writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, id, artifacts: [{ profile, name, path: name, sha256 }] }, null, 2)}\n`);
console.log(path);
