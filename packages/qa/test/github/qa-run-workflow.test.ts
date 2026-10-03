import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

// The example is never run by CI, so what it can be checked for statically is checked here: it is copied by consumers.
const lines = readFileSync(new URL('../../../../examples/tauri-smoke/.github/workflows/qa-run.yml', import.meta.url), 'utf8').split(/\r?\n/);
const indent = (line: string): number => line.length - line.trimStart().length;

/** One job of the file, from its key to the next job's. */
function job(name: string): string {
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`no job ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end]!)) end++;
  return lines.slice(start, end).join('\n');
}

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
    // The jobs are separate: the sync job starts after the run job and does not run the suite.
    expect(job('sync')).toMatch(/^ {2}sync:\n {4}needs: \[download, run\]\n/);
    expect(job('sync')).not.toMatch(/main\.ts run /);
  });

  test('the run and sync jobs check out the tool commit the download job recorded, not a moving branch', () => {
    for (const name of ['run', 'sync']) {
      expect(job(name)).toContain('ref: ${{ needs.download.outputs.tool_sha }}');
      expect(job(name)).not.toMatch(/ref: main/);
    }
    expect(job('download')).toContain('tool_sha: ${{ steps.tool.outputs.sha }}');
  });

  test('the sync job is skipped when the run job left no journal, so the real failure stays the one to read', () => {
    const text = lines.join('\n');
    expect(text).toMatch(/\n {4}if: \$\{\{ !cancelled\(\) && needs\.run\.outputs\.has_journal == 'true' \}\}\n/);
    expect(text).toContain('has_journal: ${{ steps.journal.outputs.has }}');
  });

  test('only the download job can write, and it never checks out or runs the pull request', () => {
    // A draft release's assets need a push-capable token. That job runs the pinned tool alone; the job that runs the
    // pull request's tests, and the one holding the user token, keep GITHUB_TOKEN read-only.
    const writes = (text: string): string[] => text.split('\n').filter((line) => /:\s*write(?:-all)?\s*$/.test(line));
    expect(writes(job('download'))).toEqual(['      contents: write']);
    expect(writes(job('run'))).toEqual([]);
    expect(writes(job('sync'))).toEqual([]);
    // The workflow-level permissions, outside any job (comment lines aside), grant nothing that can write either.
    expect(lines.slice(0, lines.indexOf('jobs:')).filter((line) => !line.startsWith('#') && /:\s*write/.test(line))).toEqual([]);
    expect(job('download')).not.toMatch(/ref: \$\{\{ inputs\.expected_head/);
    expect(job('download')).not.toMatch(/main\.ts run /);
    expect(job('run')).toMatch(/^ {2}run:\n {4}needs: download\n/);
  });

  test('the tool and every action are pinned to a full commit SHA, since one job can write', () => {
    const tool = job('download').split('\n');
    const toolRef = tool[tool.findIndex((line) => line.includes('repository: Frogbyte-io/release-qa')) + 1]!;
    expect(toolRef).toMatch(/^ {10}ref: [0-9a-f]{40}$/);
    const uses = lines.filter((line) => /^\s*(?:- )?uses: /.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d/);
  });

  test('the run job re-checks the verified file it was handed before the suite runs', () => {
    const run = job('run');
    expect(run.indexOf('Re-check the candidate file against its manifest')).toBeGreaterThan(run.indexOf('actions/download-artifact@'));
    expect(run.indexOf('Re-check the candidate file against its manifest')).toBeLessThan(run.indexOf('main.ts run '));
  });

  test('the run name is quoted, so the ` #` in it does not start a YAML comment', () => {
    expect(lines.find((line) => line.startsWith('run-name:'))).toMatch(/^run-name: "qa-run PR #\$\{\{ inputs\.pr_number \}\} .*inputs\.expected_head \}\}"$/);
  });

  test('a re-run replaces the artifacts of the attempt before it instead of failing on their names', () => {
    const uploads = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.includes('actions/upload-artifact@'));
    expect(uploads).toHaveLength(2);
    for (const { index } of uploads) expect(lines.slice(index, index + 8).some((line) => line.trim() === 'overwrite: true')).toBe(true);
  });

  test('no checkout leaves credentials in the checked out repository', () => {
    const checkouts = lines.filter((line) => line.includes('actions/checkout@')).length;
    expect(checkouts).toBe(4);
    expect(lines.filter((line) => line.includes('persist-credentials: false'))).toHaveLength(checkouts);
  });
});
