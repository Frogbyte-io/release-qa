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

  /** Each step of the file as its own run of lines, so a test can say which step holds a token. */
  function steps(): string[][] {
    const found: string[][] = [];
    for (const line of lines) {
      if (/^ {6}- /.test(line)) found.push([line]);
      else if (found.length > 0 && !/^ {0,4}\S/.test(line)) found.at(-1)!.push(line);
    }
    return found;
  }
  const holdsToken = (step: string[]): boolean => step.some((line) => /\$\{\{\s*(github\.token|secrets\.)/.test(line));

  test('no token sits in a job-level or workflow-level environment, only in the steps that need one', () => {
    const tokenLines = lines.map((line, index) => ({ line, index })).filter(({ line }) => /\$\{\{\s*(github\.token|secrets\.)/.test(line));
    expect(tokenLines).toHaveLength(3);
    for (const { line } of tokenLines) expect(indent(line)).toBeGreaterThan(6);
    for (const { line } of tokenLines) expect(line.trimStart().startsWith('GH_TOKEN:')).toBe(true);
  });

  test('the step that runs the pull request tests holds no token', () => {
    const suite = steps().find((step) => step.some((line) => /main\.ts run /.test(line)));
    expect(suite).toBeDefined();
    expect(holdsToken(suite!)).toBe(false);
  });

  test('only the head check, the download and the sync steps hold a token', () => {
    const withToken = steps().filter(holdsToken);
    expect(withToken.map((step) => step.find((line) => line.includes('name:'))?.trim())).toEqual([
      '- name: Validate inputs and re-check what the dashboard saw',
      '- name: Download and verify the candidate',
      '- name: Sync the report to the candidate',
    ]);
  });

  test('the report is uploaded as a user, never with the workflow token, and in a job apart from the tests', () => {
    const sync = steps().find((step) => step.some((line) => line.includes('main.ts sync-run')));
    expect(sync).toBeDefined();
    expect(sync!.some((line) => line.includes('github.token'))).toBe(false);
    expect(sync!.some((line) => line.includes('secrets.QA_SYNC_TOKEN'))).toBe(true);
    // The two jobs are separate: the sync job starts after the run job and does not run the suite.
    const text = lines.join('\n');
    expect(text).toMatch(/\n {2}sync:\n {4}needs: run\n/);
    expect(text.slice(text.indexOf('\n  sync:'))).not.toMatch(/main\.ts run /);
  });

  test('no job can write: GITHUB_TOKEN is read-only everywhere, since it is not an identity the gate accepts', () => {
    expect(lines.filter((line) => /:\s*write\s*$/.test(line))).toEqual([]);
  });

  test('no checkout leaves credentials in the checked out repository', () => {
    const checkouts = lines.filter((line) => line.includes('actions/checkout@')).length;
    expect(checkouts).toBe(3);
    expect(lines.filter((line) => line.includes('persist-credentials: false'))).toHaveLength(checkouts);
  });
});
