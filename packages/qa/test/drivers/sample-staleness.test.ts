// The sample scenario's screenshot staleness check: which pairs it compares, and that only a real match trips it.
import { describe, expect, test } from 'vitest';
import { assertFresh } from '../../../../examples/tauri-smoke/qa/persistence.spec.ts';

const shots = { saved: 'a'.repeat(64), restarted: 'b'.repeat(64), cleared: 'c'.repeat(64), restartedCleared: 'd'.repeat(64) };
const check = (s: typeof shots) => () =>
  assertFresh({ '1-saved.png': s.saved, '2-restarted.png': s.restarted }, { '3-cleared.png': s.cleared, '4-restarted-cleared.png': s.restartedCleared });

describe('the sample\'s screenshot staleness check', () => {
  test('passes when every screenshot with the value differs from every one without it', () => {
    expect(check(shots)).not.toThrow();
  });

  test('passes when screenshots on the same side match: the two empty states may render identically', () => {
    expect(check({ ...shots, restartedCleared: shots.cleared, restarted: shots.saved })).not.toThrow();
  });

  test.each([
    ['1-saved.png', '3-cleared.png', { saved: shots.cleared }],
    ['2-restarted.png', '3-cleared.png', { restarted: shots.cleared }],
    ['1-saved.png', '4-restarted-cleared.png', { saved: shots.restartedCleared }],
    ['2-restarted.png', '4-restarted-cleared.png', { restarted: shots.restartedCleared }],
  ])('%s identical to %s is a stale screenshot, reported as a plain error (interrupted, not failed)', (shown, empty, change) => {
    let thrown: unknown;
    try {
      check({ ...shots, ...change })();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('Error');
    expect((thrown as Error).message).toBe(`screenshot ${shown} is identical to ${empty} although the value was shown only in the first: the screenshot is stale`);
  });
});
