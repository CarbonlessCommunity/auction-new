import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const API_PORT = process.env.API_PORT || '8787';

export default defineConfig({
  root: resolve(__dirname, 'src/client'),
  publicDir: false,
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
      '/ws': {
        target: `ws://localhost:${API_PORT}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
