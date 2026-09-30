import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts, whose root is src/client (the SPA).
// Tests exercise the shared domain from the repo root.
//
// tests/rules/ is excluded because those tests drive the Firestore emulator —
// see vitest.rules.config.ts and `npm run test:rules`. Keeping them out means
// `npm test` stays pure and never needs a Java runtime. tests/e2e/ is
// Playwright's (`npm run test:e2e`), not Vitest's.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/rules/**', 'tests/e2e/**'],
    environment: 'node',
  },
});
