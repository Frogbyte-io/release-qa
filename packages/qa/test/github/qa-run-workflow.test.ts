import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

// The example is never run by CI, so what it can be checked for statically is checked here: it is copied by consumers.
const lines = readFileSync(new URL('../../../../examples/tauri-smoke/.github/workflows/qa-run.yml', import.meta.url), 'utf8').split(/\r?\n/);
const indent = (line: string): number => line.length - line.trimStart().length;

/** Lines that are the body of a `run:` script, where an expression would be pasted into shell text. */
function scriptLines(): string[] {
  const found: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const inline = /^\s*(?:- )?run:\s*(.*)$/.exec(line);
    // An empty value is the job that happens to be named `run`, not a script.
    if (inline === null || inline[1] === '') continue;
    if (inline[1] !== '|') { found.push(inline[1]!); continue; }
    // A block body is indented deeper than the `run` key itself, which sits after the dash in a list item.
    const key = indent(line) + (line.trimStart().startsWith('- ') ? 2 : 0);
    for (let next = index + 1; next < lines.length && (lines[next]!.trim() === '' || indent(lines[next]!) > key); next++) found.push(lines[next]!);
  }
  return found;
}

describe('the example run workflow', () => {
  test('no expression is interpolated into a run script, so inputs cannot become shell code', () => {
    const scripts = scriptLines();
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((line) => line.includes('${{'))).toEqual([]);
  });

  test('the token is scoped to the step that needs it, not the job that runs the pull request tests', () => {
    const tokenLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.includes('GH_TOKEN:'));
    expect(tokenLines).toHaveLength(1);
    expect(indent(tokenLines[0]!.line)).toBeGreaterThan(6);
  });

  test('neither checkout leaves credentials in the checked out repository', () => {
    const checkouts = lines.filter((line) => line.includes('actions/checkout@')).length;
    expect(checkouts).toBe(2);
    expect(lines.filter((line) => line.includes('persist-credentials: false'))).toHaveLength(checkouts);
  });
});
