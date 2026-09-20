import { expect, test } from 'vitest';
import { toolName } from '../src/index.ts';

// Proves the TypeScript + Vitest toolchain is wired up on every supported OS.
test('the package entry point loads', () => {
  expect(toolName).toBe('release-qa');
});
