// The Stage 0 persistence check as a Release QA scenario: save a value, confirm it on disk independently, restart the
// app and see it again, clear it, restart and see it gone. Waiting uses the runner's `ctx.waitFor`, so a value that
// never appears is an assertion failure (the candidate misbehaved), not an infrastructure error; checks on disk use
// node:assert. Elements are found by id, as in Stage 0. A screenshot of the app is kept as evidence after each change.
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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

/**
 * A screenshot taken while the value is shown must differ from one taken while it is not. Stage 0 saw WebKitGTK return
 * the previous frame (native-automation finding 4); a stale screenshot is a broken record, not a candidate that
 * misbehaved (the DOM checks already passed), so it is a plain error: the attempt is interrupted, not failed.
 */
export function assertFresh(withValue: Record<string, string>, withoutValue: Record<string, string>): void {
  for (const [shown, shownHash] of Object.entries(withValue)) {
    for (const [empty, emptyHash] of Object.entries(withoutValue)) {
      if (shownHash === emptyHash) throw new Error(`screenshot ${shown} is identical to ${empty} although the value was shown only in the first: the screenshot is stale`);
    }
  }
}

export const scenarios = [
  {
    id: 'persistence',
    async steps(ctx: RunContext): Promise<void> {
      const value = `release-qa ${randomUUID().slice(0, 8)} åäö ✓`;

      await shows(ctx, '', 'the readout to start empty');
      await (await session().browser.$('#setting-input')).setValue(value);
      await (await session().browser.$('#save-button')).click();
      await shows(ctx, value, 'the saved value to be shown');
      const saved = await capture(ctx, '1-saved.png');
      // Checked as an assertion first: a Save that wrote nothing is the candidate failing, not a read error.
      assert.ok(existsSync(settingFile()), `Save writes ${settingFile()}`);
      assert.equal(readFileSync(settingFile(), 'utf8'), value, `the value on disk in ${settingFile()}`);

      await session().restart(ctx);
      await shows(ctx, value, 'the saved value to be shown after a restart');
      const restarted = await capture(ctx, '2-restarted.png');

      await (await session().browser.$('#clear-button')).click();
      await shows(ctx, '', 'the value to be cleared');
      const cleared = await capture(ctx, '3-cleared.png');
      assert.equal(existsSync(settingFile()), false, `Clear removes ${settingFile()}`);

      await session().restart(ctx);
      await shows(ctx, '', 'the cleared state to be shown after a restart');
      const restartedCleared = await capture(ctx, '4-restarted-cleared.png');
      // The readout starts empty in the page itself, so it alone cannot show that a restart did not bring the value
      // back; the file is the independent check, as after every other step.
      assert.equal(existsSync(settingFile()), false, `${settingFile()} stays removed after a restart`);

      assertFresh({ '1-saved.png': saved, '2-restarted.png': restarted }, { '3-cleared.png': cleared, '4-restarted-cleared.png': restartedCleared });
    },
  },
];
