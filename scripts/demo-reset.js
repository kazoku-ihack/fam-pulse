// Wipes and reseeds all demo data. Never touches the `wallets` table (chain contract
// addresses persist), and chain-side nonces live in the deployed contract, not this DB.
import 'dotenv/config';
import { openDb, resetDb } from '../src/db.js';

const db = openDb();
resetDb(db);
console.log('Demo data reset and reseeded.');
