import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Streams a file so installer-sized assets are not held in memory. */
export function sha256Of(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', rejectHash)
      .on('end', () => resolveHash(hash.digest('hex')));
  });
}
