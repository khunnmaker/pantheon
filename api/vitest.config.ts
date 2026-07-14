import { defineConfig } from 'vitest/config';

// Minimal vitest config for the Minerva API package. ESM + Node, explicit imports
// (no globals) so test files stay ordinary TypeScript modules. Tests live under test/
// plus focused colocated unit tests under src/ — no DB, no network.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
