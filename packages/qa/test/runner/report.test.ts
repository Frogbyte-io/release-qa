import { describe, expect, test } from 'vitest';
import { renderReport } from '../../src/runner/report.ts';
import type { Attempt } from '../../src/model/result.ts';
import { report } from '../fixtures/records.ts';

const attempt = (id: string, overrides: Partial<Attempt> = {}): Attempt => ({ id, requirement: 'windows/persistence', outcome: 'passed', evidence: [], ...overrides });

describe('JSON export', () => {
  test('is valid JSON equal to the report when nothing is redacted', () => {
    const r = report();
    expect(JSON.parse(renderReport(r).json)).toEqual(r);
  });

  test('is byte-for-byte reproducible', () => {
    const r = report({ attempts: [attempt('a1'), attempt('a2', { outcome: 'failed' })] });
    const first = renderReport(r);
    expect(JSON.parse(first.json)).toEqual(r);
    expect(first.html).toContain('a2');
    expect(first).toEqual(renderReport(structuredClone(r)));
  });
});

describe('HTML export', () => {
  test('is a complete document that shows every attempt and every outcome, failures included', () => {
    const { html } = renderReport(report({ attempts: [attempt('a1'), attempt('a2', { outcome: 'failed' }), attempt('a3', { outcome: 'interrupted', requirement: 'windows/device-feel' })] }));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    for (const text of ['a1', 'a2', 'a3', 'passed', 'failed', 'interrupted', 'windows/persistence', 'windows/device-feel', 'report-0001', 'cand-0001']) {
      expect(html).toContain(text);
    }
  });

  test('escapes markup in every text field', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>"&\'';
    const r = report({
      actor: hostile,
      machineId: hostile,
      environment: { os: hostile, osVersion: hostile, arch: hostile, capabilities: [hostile], toolVersion: hostile },
      attempts: [attempt(hostile as string)],
    });
    const { html } = renderReport(r);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/onerror\s*=(?![^<]*&)/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&amp;');
  });

  test('never lets an unexpected outcome value reach an attribute', () => {
    const outcome = 'passed" onmouseover="alert(1)' as unknown as Attempt['outcome'];
    const { html } = renderReport(report({ attempts: [attempt('a1', { outcome })] }));
    expect(html).toContain('class="outcome-unknown"');
    expect(html).not.toMatch(/onmouseover="/);
    expect(html).toContain('onmouseover=&quot;alert(1)');
  });

  test('is self-contained: no scripts, no external resources, and a policy forbidding them', () => {
    const { html } = renderReport(report({ attempts: [attempt('a1', { evidence: ['evidence/a.png'] })] }));
    expect(html).not.toMatch(/<script|<link|<iframe|<object|<embed|<img|@import|url\(/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).toContain("default-src 'none'");
  });

  test('links evidence by relative path, with each segment percent-encoded', () => {
    const { html } = renderReport(report({ attempts: [attempt('a1', { evidence: ['evidence/my shot #1.png', 'logs/a&b.txt'] })] }));
    expect(html).toContain('href="evidence/my%20shot%20%231.png"');
    expect(html).toContain('href="logs/a%26b.txt"');
  });

  test.each([['../../etc/passwd'], ['/etc/passwd'], ['javascript:alert(1)'], ['C:\\Windows\\win.ini'], ['evidence\\a.png'], ['a//b.png']])(
    'shows the unsafe evidence path %j as text and never as a link',
    (path) => {
      const { html } = renderReport(report({ attempts: [attempt('a1', { evidence: [path] })] }));
      expect(html).not.toMatch(/href="[^"]*(etc|javascript|Windows|evidence\\|a\/\/b)/);
      expect(html).toContain('not linked');
    },
  );

  test('limits the evidence links shown per attempt and says how many were left out', () => {
    const evidence = ['e/1.png', 'e/2.png', 'e/3.png', 'e/4.png', 'e/5.png'];
    const r = report({ attempts: [attempt('a1', { evidence })] });
    const { html, json } = renderReport(r, { maxEvidencePerAttempt: 2 });
    expect(html).toContain('e/1.png');
    expect(html).toContain('e/2.png');
    expect(html).not.toContain('e/3.png');
    expect(html).toContain('3 more not shown');
    expect(JSON.parse(json).attempts[0].evidence).toEqual(evidence);
  });
});

describe('redaction', () => {
  const secret = 'ghp_SECRET_TOKEN_1234567890';

  test('removes a secret from both outputs wherever it appears', () => {
    const r = report({
      actor: `tester-${secret}`,
      machineId: `host ${secret}`,
      environment: { os: 'windows', osVersion: secret, arch: 'x86_64', capabilities: ['display'], toolVersion: '0.0.0' },
      attempts: [attempt('a1', { evidence: [`logs/${secret}.txt`] })],
    });
    const { json, html } = renderReport(r, { redact: [secret] });
    expect(json).not.toContain(secret);
    expect(html).not.toContain(secret);
    expect(json).toContain('[redacted]');
    expect(html).toContain('[redacted]');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('also removes a secret that contains characters HTML would escape', () => {
    const tricky = 'p<w>&"x';
    const { html } = renderReport(report({ actor: `a-${tricky}-b` }), { redact: [tricky] });
    expect(html).toContain('a-[redacted]-b');
    expect(html).not.toContain('p&lt;w&gt;');
    expect(html).not.toContain(tricky);
  });

  test('redacts every secret and ignores empty entries instead of looping or blanking the report', () => {
    const { json } = renderReport(report({ actor: 'alpha-SECRET1-beta-SECRET2' }), { redact: ['', 'SECRET1', 'SECRET2'] });
    expect(JSON.parse(json).actor).toBe('alpha-[redacted]-beta-[redacted]');
  });

  test('redacts the longest secret first so a shorter one cannot leave part of it behind', () => {
    const { json, html } = renderReport(report({ actor: 'x-SECRET-LONGER-y' }), { redact: ['SECRET', 'SECRET-LONGER'] });
    expect(JSON.parse(json).actor).toBe('x-[redacted]-y');
    expect(html).not.toContain('LONGER');
  });

  test('leaves a report untouched when there is nothing to redact', () => {
    const r = report();
    expect(JSON.parse(renderReport(r, { redact: [] }).json)).toEqual(r);
  });

  test('does not modify the report it was given', () => {
    const r = report({ actor: `x-${secret}` });
    const frozen = JSON.parse(JSON.stringify(r));
    const rendered = renderReport(r, { redact: [secret] });
    expect(JSON.parse(rendered.json).actor).toBe('x-[redacted]');
    expect(r).toEqual(frozen);
  });
});
