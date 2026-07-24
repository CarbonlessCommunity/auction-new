import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, Repository } from './db';
import { Realtime } from './realtime';
import { createRoutes } from './routes';

export const DEFAULT_DB_FILE = process.env.AUCTION_DB ?? resolve(process.cwd(), 'data/auction.sqlite');

export function createApp(dbFile = DEFAULT_DB_FILE) {
  const repo = new Repository(openDatabase(dbFile));
  const realtime = new Realtime(repo);

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', createRoutes(repo, realtime));

  // In production the built SPA is served by this same process; in dev Vite
  // serves it on :5173 and proxies /api and /ws back here.
  const clientDir = resolve(process.cwd(), 'dist/client');
  if (existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get('*', (_req, res) => res.sendFile(resolve(clientDir, 'index.html')));
  }

  const server = createServer(app);
  realtime.attach(server);

  return { app, server, repo, realtime };
}
