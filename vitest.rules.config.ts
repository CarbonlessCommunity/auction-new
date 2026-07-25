import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * The Firestore security-rules suite. Run it through `npm run test:rules`,
 * which wraps it in `firebase emulators:exec` so the emulator's lifetime is
 * tied to the test run.
 *
 * Single-threaded on purpose: every test in the file shares one emulator
 * project, and `clearFirestore()` in `beforeEach` would wipe a parallel
 * worker's fixture out from under it.
 */
export default defineConfig({
  root: __dirname,
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    include: ['tests/rules/**/*.test.ts'],
    fileParallelism: false,
    // Rule evaluation does document reads of its own, so each assertion is a
    // round trip or three; the 5s default is tight for the seeded fixtures.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
