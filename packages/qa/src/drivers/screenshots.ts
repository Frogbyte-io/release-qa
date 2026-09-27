/**
 * Checks that screenshots taken in states that look different are different: every hash in `one` must differ from
 * every hash in `other` (keys name the screenshots). Stage 0 saw WebKitGTK return the previous frame (native-automation
 * finding 4), so a match means a stale screenshot. That is a broken record, not a candidate that misbehaved (the
 * scenario's own assertions decide that), so it throws a plain error: the attempt is interrupted, not failed.
 */
export function assertScreenshotsDiffer(one: Record<string, string>, other: Record<string, string>): void {
  for (const [a, aHash] of Object.entries(one)) {
    for (const [b, bHash] of Object.entries(other)) {
      if (aHash === bHash) throw new Error(`screenshot ${a} is identical to ${b}, which was taken in a state that looks different: the screenshot is stale`);
    }
  }
}
