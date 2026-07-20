import { openDb, seed } from '../src/db.js';
import { createApp } from '../src/server.js';

process.env.API_KEY = process.env.API_KEY || 'test-key';

export const API_KEY = process.env.API_KEY;

export function setupApp(deps = {}) {
  const db = openDb(':memory:');
  seed(db);
  const app = createApp(db, deps);
  return { app, db };
}
