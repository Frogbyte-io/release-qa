import { at, Collector, item, parseUnversioned, type FieldSpec, type ParseResult } from './validate.ts';

/** `<environment profile>/<scenario id>`, e.g. `windows/persistence`. */
export type RequirementKey = `${string}/${string}`;
export type ExecutionMode = 'automated' | 'manual';

export interface Requirement {
  key: RequirementKey;
  mode: ExecutionMode;
  title: string;
  /** Capabilities the environment must provide, e.g. `display`, `audio`, `hardware`. */
  capabilities: string[];
}

const SPEC: FieldSpec = { required: ['key', 'mode', 'title', 'capabilities'] };

/** The profile half of a requirement key. */
export const profileOf = (key: RequirementKey): string => key.slice(0, key.indexOf('/'));

/** Reads a requirement nested in another record, reporting problems under `path`. */
export function readRequirement(c: Collector, value: unknown, path: string): Requirement | undefined {
  const rec = c.record(value, path, SPEC);
  return rec === undefined ? undefined : readRequirementFields(c, rec, path);
}

function readRequirementFields(c: Collector, rec: Record<string, unknown>, path: string): Requirement {
  const capabilities = (c.array(rec.capabilities, at(path, 'capabilities')) ?? []).map((v, i) => c.name(v, item(at(path, 'capabilities'), i)));
  return {
    key: c.requirementKey(rec.key, at(path, 'key')),
    mode: c.oneOf(rec.mode, at(path, 'mode'), ['automated', 'manual']),
    title: c.text(rec.title, at(path, 'title')),
    capabilities,
  } as Requirement;
}

export function parseRequirement(input: unknown): ParseResult<Requirement> {
  return parseUnversioned(input, SPEC, (c, rec) => readRequirementFields(c, rec, ''));
}
