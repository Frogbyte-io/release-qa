// The Stage 0 persistence check as a Release QA scenario: save a value, confirm it on disk independently, restart the
// app and see it again, clear it, restart and see it gone. Waiting uses the runner's `ctx.waitFor`, so a value that
// never appears is an assertion failure (the candidate misbehaved), not an infrastructure error; checks on disk use
// node:assert. Elements are found by id, as in Stage 0.
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

export const scenarios = [
  {
    id: 'persistence',
    async steps(ctx: RunContext): Promise<void> {
      const value = `release-qa ${randomUUID().slice(0, 8)} åäö ✓`;

      await shows(ctx, '', 'the readout to start empty');
      await (await session().browser.$('#setting-input')).setValue(value);
      await (await session().browser.$('#save-button')).click();
      await shows(ctx, value, 'the saved value to be shown');
      assert.equal(readFileSync(settingFile(), 'utf8'), value, `the value on disk in ${settingFile()}`);

      await session().restart();
      await shows(ctx, value, 'the saved value to be shown after a restart');

      await (await session().browser.$('#clear-button')).click();
      await shows(ctx, '', 'the value to be cleared');
      assert.equal(existsSync(settingFile()), false, `Clear removes ${settingFile()}`);

      await session().restart();
      await shows(ctx, '', 'the cleared state to be shown after a restart');
    },
  },
];
