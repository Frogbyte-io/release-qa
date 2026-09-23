import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseLocalCandidate } from '../model/local-candidate.ts';
import type { ArtifactRef, CandidateRef } from '../runner/execute.ts';

export type LoadedCandidate = { ok: true; candidate: CandidateRef; artifact: ArtifactRef } | { ok: false; error: string };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Reads a local candidate manifest, picks the artifact for `profile`, and checks the file's bytes against the
 * manifest's SHA-256 before anything is installed. Never throws. Only the chosen profile's file is read.
 */
export async function loadCandidate(manifestPath: string, profile: string): Promise<LoadedCandidate> {
  let text: string;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (error) {
    return { ok: false, error: `could not read the candidate manifest ${manifestPath}: ${message(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${manifestPath} is not valid JSON: ${message(error)}` };
  }
  const result = parseLocalCandidate(parsed);
  if (!result.ok) return { ok: false, error: `${manifestPath}: ${result.error.message}` };
  const manifest = result.value;

  const chosen = manifest.artifacts.find((a) => a.profile === profile);
  if (chosen === undefined) {
    return { ok: false, error: `candidate "${manifest.id}" has no artifact for profile "${profile}"; it has: ${manifest.artifacts.map((a) => a.profile).join(', ')}` };
  }

  // Relative to the manifest, not to wherever the command happens to be run from.
  const path = resolve(dirname(manifestPath), ...chosen.path.split('/'));
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) return { ok: false, error: `the artifact ${path} for profile "${profile}" does not exist` };
  if (!info.isFile()) return { ok: false, error: `the artifact ${path} for profile "${profile}" is not a file` };

  let actual: string;
  try {
    actual = await sha256Of(path);
  } catch (error) {
    return { ok: false, error: `could not read the artifact ${path}: ${message(error)}` };
  }
  if (actual !== chosen.sha256) {
    return { ok: false, error: `the artifact ${path} does not match the candidate: expected SHA-256 ${chosen.sha256}, found ${actual}` };
  }
  return { ok: true, candidate: { id: manifest.id }, artifact: { name: chosen.name, path, sha256: actual } };
}

/** Streams the file, so an installer of any size is hashed without being held in memory. */
function sha256Of(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', rejectHash)
      .on('end', () => resolveHash(hash.digest('hex')));
  });
}
