import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reading a process's identity starts PowerShell on Windows, which can take several seconds on a busy CI runner.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
