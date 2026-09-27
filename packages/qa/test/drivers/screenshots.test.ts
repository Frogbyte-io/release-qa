import { describe, expect, test } from 'vitest';
import { assertScreenshotsDiffer } from '../../src/drivers/screenshots.ts';

// As the sample uses it: two screenshots with the value shown, two without.
const shots = { saved: 'a'.repeat(64), restarted: 'b'.repeat(64), cleared: 'c'.repeat(64), restartedCleared: 'd'.repeat(64) };
const check = (s: typeof shots) => () =>
  assertScreenshotsDiffer({ '1-saved.png': s.saved, '2-restarted.png': s.restarted }, { '3-cleared.png': s.cleared, '4-restarted-cleared.png': s.restartedCleared });

describe('checking screenshots for staleness', () => {
  test('passes when every screenshot on one side differs from every one on the other', () => {
    expect(check(shots)).not.toThrow();
  });

  test('passes when screenshots on the same side match: two empty states may render identically', () => {
    expect(check({ ...shots, restartedCleared: shots.cleared, restarted: shots.saved })).not.toThrow();
  });

  test.each([
    ['1-saved.png', '3-cleared.png', { saved: shots.cleared }],
    ['2-restarted.png', '3-cleared.png', { restarted: shots.cleared }],
    ['1-saved.png', '4-restarted-cleared.png', { saved: shots.restartedCleared }],
    ['2-restarted.png', '4-restarted-cleared.png', { restarted: shots.restartedCleared }],
  ])('%s identical to %s is stale, reported as a plain error (interrupted, not failed)', (a, b, change) => {
    let thrown: unknown;
    try {
      check({ ...shots, ...change })();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('Error');
    expect((thrown as Error).message).toBe(`screenshot ${a} is identical to ${b}, which was taken in a state that looks different: the screenshot is stale`);
  });
});
