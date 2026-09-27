import { describe, expect, test } from 'vitest';
import type { Evaluation } from '../../src/model/evaluate.ts';
import { renderQaSection } from '../../src/github/gate.ts';
import { updateManagedSections } from '../../src/github/pull-request.ts';

const evaluation = (changes: Partial<Evaluation> = {}): Evaluation => ({
  readiness: 'passed', reasons: [], excused: [], acceptedReportIds: ['report-1'], exceptionIds: [], ignored: [], ...changes,
});

describe('managed PR sections', () => {
  const body = 'Intro 🌍\n\n<!-- release-notes:start -->\nHuman-edited notes\n<!-- release-notes:end -->\n\n<!-- qa:start -->\nOld QA\n<!-- qa:end -->\n\nFooter';

  test('replaces only the named generated section and keeps Unicode and human notes intact', () => {
    expect(updateManagedSections(body, [{ name: 'qa', content: 'New QA ✓', expected: 'Old QA' }])).toEqual({
      ok: true,
      body: body.replace('Old QA', 'New QA ✓'),
    });
  });

  test('refuses a concurrent or manual change inside a section', () => {
    expect(updateManagedSections(body, [{ name: 'qa', content: 'New QA', expected: 'Prior QA' }])).toEqual({
      ok: false, error: 'qa section changed since it was read',
    });
  });

  test.each([
    ['missing end', '<!-- qa:start -->\nOld QA'],
    ['duplicate start', '<!-- qa:start --><!-- qa:start --><!-- qa:end -->'],
    ['reversed', '<!-- qa:end --><!-- qa:start -->'],
  ])('refuses %s markers instead of replacing the PR body', (_case, malformed) => {
    expect(updateManagedSections(malformed, [{ name: 'qa', content: 'New QA' }]).ok).toBe(false);
  });

  test('preserves CRLF around a generated section', () => {
    const crlf = '<!-- qa:start -->\r\nOld QA\r\n<!-- qa:end -->';
    expect(updateManagedSections(crlf, [{ name: 'qa', content: 'New QA' }])).toEqual({
      ok: true, body: '<!-- qa:start -->\r\nNew QA\r\n<!-- qa:end -->',
    });
  });

  test('refuses nested sections and repeated names', () => {
    const nested = '<!-- qa:start -->\n<!-- release-notes:start -->\nNotes\n<!-- release-notes:end -->\n<!-- qa:end -->';
    expect(updateManagedSections(nested, [
      { name: 'qa', content: 'QA' }, { name: 'release-notes', content: 'Notes' },
    ])).toEqual({ ok: false, error: 'managed sections overlap' });
    expect(updateManagedSections(body, [{ name: 'qa', content: 'A' }, { name: 'qa', content: 'B' }])).toEqual({
      ok: false, error: 'invalid or repeated section name: qa',
    });
  });

  test('refuses invalid layout and markers injected into another managed section', () => {
    expect(updateManagedSections('<!-- qa:start -->Old QA<!-- qa:end -->', [{ name: 'qa', content: 'New QA' }]).ok).toBe(false);
    expect(updateManagedSections(body, [
      { name: 'release-notes', content: '<!-- qa:start -->\nInjected\n<!-- qa:end -->' },
      { name: 'qa', content: 'New QA' },
    ]).ok).toBe(false);
  });
});

describe('QA section', () => {
  test('shows a passed evaluation, plural reports and why records were ignored', () => {
    const output = renderQaSection(evaluation({
      acceptedReportIds: ['report-1', 'report-2'],
      ignored: [{ kind: 'report', id: 'replayed', reason: 'duplicate-replay' }, { kind: 'report', id: 'conflict', reason: 'conflicting-report-id' }],
    }));
    expect(output).toContain('QA: Passed');
    expect(output).toContain('2 accepted reports');
    expect(output).toContain('duplicate-replay');
    expect(output).toContain('conflicting-report-id');
    expect(output).not.toContain('stale or ineligible');
  });

  test('shows every blocking reason and the accepted report count', () => {
    const output = renderQaSection(evaluation({ readiness: 'blocked', reasons: [
      { code: 'head-changed', expected: 'old', actual: 'new' },
      { code: 'missing-result', requirement: 'windows/persistence' },
    ] }));
    expect(output).toContain('Blocked');
    expect(output).toContain('windows/persistence');
    expect(output).toContain('old');
    expect(output).toContain('new');
    expect(output).toContain('1 accepted report');
  });

  test('makes approved exceptions conspicuous and escapes record text', () => {
    const output = renderQaSection(evaluation({
      readiness: 'approved-with-exceptions',
      excused: [{ reason: { code: 'missing-result', requirement: 'windows/<unsafe>|data' }, exceptionId: 'ex-1' }],
      exceptionIds: ['ex-1'],
    }));
    expect(output).toContain('Approved with exceptions');
    expect(output).toContain('&lt;unsafe&gt;');
    expect(output).toContain('\\|data');
    expect(output).toContain('ex-1');
    expect(output).not.toContain('<unsafe>');
  });
});
