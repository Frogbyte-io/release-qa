// Writes a local candidate manifest for the package this machine just built: the NSIS installer on Windows, the .deb
// on Linux. It hashes the file as it is now; build again and you have a new candidate, so run this again.
//
//   node scripts/write-candidate.mjs [id]
//
// The manifest goes next to the bundles (src-tauri/target/release/bundle/candidate.json), because a manifest may only
// name files in or under its own directory. Its path is printed for `release-qa run --candidate`.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundle = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'target', 'release', 'bundle');
const [profile, kind, extension] = process.platform === 'win32' ? ['windows', 'nsis', '.exe'] : ['linux', 'deb', '.deb'];

const files = readdirSync(join(bundle, kind)).filter((name) => name.endsWith(extension));
if (files.length !== 1) {
  console.error(`expected exactly one ${extension} in ${join(bundle, kind)}, found ${files.length}: build the sample first (npm run build:${profile})`);
  process.exit(1);
}
const [name] = files;
const sha256 = createHash('sha256').update(readFileSync(join(bundle, kind, name))).digest('hex');
const id = process.argv[2] ?? `local-${profile}-${sha256.slice(0, 12)}`;
const path = join(bundle, 'candidate.json');
writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, id, artifacts: [{ profile, name, path: `${kind}/${name}`, sha256 }] }, null, 2)}\n`);
console.log(path);
