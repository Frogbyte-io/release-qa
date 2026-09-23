import {
  acquireTestRoot,
  checkTestRoot,
  designateTestRoot,
  readDirty,
  readLedger,
  resetDirtyEnvironment,
  type OwnedResource,
  type TestRootCheck,
} from '../runner/resources.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `options.home` is a test seam only: production callers never pass it, so the real home directory is always used. */
export interface EnvironmentCommandOptions {
  home?: string;
}

export type DesignateResult = { ok: true; root: string } | { ok: false; error: string };

/** Marks a directory as somewhere the runner may install, launch and delete. Never throws. */
export async function runDesignate(root: string, options: EnvironmentCommandOptions = {}): Promise<DesignateResult> {
  try {
    await designateTestRoot(root, options);
    return { ok: true, root };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export interface StatusReport {
  root: string;
  designated: boolean;
  /** Present only when `designated` is false: which check failed. */
  reason?: Exclude<TestRootCheck, { ok: true }>['reason'];
  /** Present only when the environment was left dirty by an earlier run. */
  dirty?: string;
  owned: OwnedResource[];
}

export type StatusResult = { ok: true; report: StatusReport } | { ok: false; error: string };

/**
 * Reports what this root is and holds, without changing anything. An undesignated or malformed root is a normal
 * report (`designated: false`), not an error; only a root this cannot read at all is an error.
 */
export async function runStatus(root: string, options: EnvironmentCommandOptions = {}): Promise<StatusResult> {
  try {
    const check = await checkTestRoot(root, options);
    if (!check.ok) return { ok: true, report: { root, designated: false, reason: check.reason, owned: [] } };

    const [dirty, owned] = await Promise.all([readDirty(check.root), readLedger(check.root)]);
    return { ok: true, report: { root: check.root, designated: true, owned, ...(dirty === undefined ? {} : { dirty }) } };
  } catch (error) {
    // Covers checkTestRoot too: it can throw if the root is removed between its own existence check and resolving
    // the real path, a narrow race this function's "never throws" promise still needs to hold against.
    return { ok: false, error: `could not read the state of ${root}: ${message(error)}` };
  }
}

export type ResetResult = { ok: true; root: string; failures: string[] } | { ok: false; error: string };

/**
 * Reaps what earlier runs left owned in this root and, only when that fully succeeds, clears the dirty marker so the
 * root can be used again. Only a designated root is touched, and only while no run holds it: resetting under a run
 * would reap resources that run still uses. Never throws.
 */
export async function runReset(root: string, options: EnvironmentCommandOptions = {}): Promise<ResetResult> {
  try {
    const check = await checkTestRoot(root, options);
    if (!check.ok) return { ok: false, error: `${root} is not a designated test root (${check.reason}); nothing was touched` };
    const lock = await acquireTestRoot(check.root);
    if (!lock.ok) return { ok: false, error: `${check.root} is in use by ${lock.heldBy}; nothing was touched` };
    try {
      const { failures } = await resetDirtyEnvironment(check.root);
      return {
        ok: true,
        root: check.root,
        failures: failures.map((f) => `${f.resource.label}: ${f.reason}${f.detail === undefined ? '' : ` (${f.detail})`}`),
      };
    } finally {
      await lock.release();
    }
  } catch (error) {
    return { ok: false, error: `could not reset ${root}: ${message(error)}` };
  }
}
