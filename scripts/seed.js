import 'dotenv/config';
import { openDb, seedIfEmpty } from '../src/db.js';

const db = openDb();
seedIfEmpty(db);
console.log('Seed complete (no-op if data already existed).');
