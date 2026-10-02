import { describe, expect, it } from 'vitest';
import { waitForLoaded } from '../src/main/capture.ts';

/** A window whose page shows the loading line for the first `loadingReads` reads. */
function fakeWindow(loadingReads: number) {
  let reads = 0;
  return {
    reads: () => reads,
    window: { webContents: { executeJavaScript: async () => ++reads <= loadingReads } } as never,
  };
}

describe('capturing a live window', () => {
  it('waits while the page still shows its loading line', async () => {
    const { window, reads } = fakeWindow(3);
    await waitForLoaded(window, 5000, 1);
    expect(reads()).toBe(4);
  });

  it('returns at once when the page is already loaded, as a recorded snapshot is', async () => {
    const { window, reads } = fakeWindow(0);
    await waitForLoaded(window, 5000, 1);
    expect(reads()).toBe(1);
  });

  it('fails instead of capturing a page that never finishes loading', async () => {
    const { window } = fakeWindow(Number.POSITIVE_INFINITY);
    await expect(waitForLoaded(window, 30, 5)).rejects.toThrow('still loading after 30 ms');
  });
});
