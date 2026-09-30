import { defineConfig } from '@playwright/test';

/**
 * The browser-level smoke test. Run it through `npm run test:e2e`, which
 * wraps it in `firebase emulators:exec` so a fresh Auth + Firestore emulator
 * lives exactly as long as the run; Playwright starts the Vite dev server
 * itself, pointed at those emulators.
 *
 * One worker: the test seeds its own admin account and auction, and the
 * emulator is a single shared project.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  // Most waits here are for a Firestore round trip or a 5s roster poll.
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'VITE_USE_EMULATOR=1 npx vite --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
