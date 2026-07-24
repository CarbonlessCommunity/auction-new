import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts, whose root is src/client (the SPA).
// Tests exercise the server + shared domain from the repo root.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
