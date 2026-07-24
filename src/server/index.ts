import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app';

// Entry point only. `createApp` lives in ./app so tests can import it without
// starting a listener.
const PORT = Number(process.env.API_PORT ?? 8787);

const { server } = createApp();
server.listen(PORT, () => {
  console.log(`auction server listening on http://localhost:${PORT}`);
  if (!existsSync(resolve(process.cwd(), 'dist/client'))) {
    console.log('client dev server: http://localhost:5173');
  }
});
