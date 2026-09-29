// The Stage 0 persistence check as a Release QA scenario, for an Electron app: save a value, confirm it on disk
// independently, restart the app and see it again, clear it, restart and see it gone. Waiting uses the runner's
// `ctx.waitFor`, so a value that never appears is an assertion failure (the candidate misbehaved), not an infrastructure
// error; checks on disk use node:assert. Elements are found by id. A screenshot of the app is kept as evidence after
// each change, and a failure also keeps the page's DOM and console (see `captureFailureEvidence`).
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { assertScreenshotsDiffer } from '../../../packages/qa/src/drivers/screenshots.ts';
import type { RunContext } from '../../../packages/qa/src/runner/execute.ts';
import { session, settingFile } from './app.ts';

/** The readout's text, or undefined if it cannot be read yet (e.g. the page is still loading after a restart). */
async function readout(): Promise<string | undefined> {
  return (await session().browser.$('#saved-value')).getText().catch(() => undefined);
}

const shows = (ctx: RunContext, expected: string, description: string): Promise<void> =>
  ctx.waitFor(async () => (await readout()) === expected, { timeoutMs: 20_000, intervalMs: 200, description });

/** Saves a screenshot of the app as the attempt's evidence and returns its SHA-256. */
const capture = async (ctx: RunContext, name: string): Promise<string> => session().screenshot(await ctx.evidence(name));

async function persistence(ctx: RunContext): Promise<void> {
  const file = settingFile(ctx);
  const value = `release-qa ${randomUUID().slice(0, 8)} åäö ✓`;

  await shows(ctx, '', 'the readout to start empty');
  await (await session().browser.$('#setting-input')).setValue(value);
  await (await session().browser.$('#save-button')).click();
  await shows(ctx, value, 'the saved value to be shown');
  const saved = await capture(ctx, '1-saved.png');
  // Checked as an assertion first: a Save that wrote nothing is the candidate failing, not a read error.
  assert.ok(existsSync(file), `Save writes ${file}`);
  assert.equal(readFileSync(file, 'utf8'), value, `the value on disk in ${file}`);

  await session().restart(ctx);
  await shows(ctx, value, 'the saved value to be shown after a restart');
  const restarted = await capture(ctx, '2-restarted.png');

  await (await session().browser.$('#clear-button')).click();
  await shows(ctx, '', 'the value to be cleared');
  const cleared = await capture(ctx, '3-cleared.png');
  assert.equal(existsSync(file), false, `Clear removes ${file}`);

  await session().restart(ctx);
  await shows(ctx, '', 'the cleared state to be shown after a restart');
  const restartedCleared = await capture(ctx, '4-restarted-cleared.png');
  // The readout starts empty in the page itself, so it alone cannot show that a restart did not bring the value
  // back; the file is the independent check, as after every other step.
  assert.equal(existsSync(file), false, `${file} stays removed after a restart`);

  // Taken with the value shown and without it, so each pair must differ; a match is a stale screenshot.
  assertScreenshotsDiffer({ '1-saved.png': saved, '2-restarted.png': restarted }, { '3-cleared.png': cleared, '4-restarted-cleared.png': restartedCleared });
}

export const scenarios = [
  {
    id: 'persistence',
    async steps(ctx: RunContext): Promise<void> {
      try {
        await persistence(ctx);
      } catch (error) {
        // What was on screen and in the console when it went wrong; best effort, since the session may be the problem.
        await session().captureFailureEvidence(ctx, 'failure').catch(() => undefined);
        throw error;
      }
    },
  },
];
