import { readFile } from 'node:fs/promises';
import { parseProject, type Project } from '../model/project.ts';
import type { ValidationIssue } from '../model/validate.ts';

export type LoadedProject = { ok: true; project: Project; path: string } | { ok: false; error: string; issues?: readonly ValidationIssue[] };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Reads and validates a `qa/project.json`. Never throws: every way the file can be wrong becomes a `{ ok: false }`. */
export async function loadProject(path: string): Promise<LoadedProject> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { ok: false, error: `could not read ${path}: ${message(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${path} is not valid JSON: ${message(error)}` };
  }

  const result = parseProject(parsed);
  if (!result.ok) return { ok: false, error: `${path}: ${result.error.message}`, issues: result.error.issues };
  return { ok: true, project: result.value, path };
}
