import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFRS } from './frs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'kazoku.sqlite');

// Yoshiko's home (the elder/parent-role household, yoshiko-001) — Akita City, Akita Prefecture.
export const HOME = { lat: 39.7186, lng: 140.1024 };
export const DEFAULT_PARENT_ID = 'yoshiko-001';
export const SECOND_PARENT_ID = 'yoshiko-002';

export function openDb(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      parentId TEXT NOT NULL,
      date TEXT NOT NULL,
      dailySteps INTEGER,
      sleepHours REAL,
      heartRateAvg INTEGER,
      heartRateResting INTEGER,
      ts INTEGER,
      PRIMARY KEY (parentId, date)
    );

    CREATE TABLE IF NOT EXISTS frs_history (
      parentId TEXT NOT NULL,
      date TEXT NOT NULL,
      score INTEGER,
      factors_json TEXT,
      PRIMARY KEY (parentId, date)
    );

    CREATE TABLE IF NOT EXISTS frs_reviews (
      id TEXT PRIMARY KEY,
      parentId TEXT NOT NULL,
      ts INTEGER NOT NULL,
      conditionType TEXT NOT NULL,
      conditionKey TEXT NOT NULL,
      decision TEXT NOT NULL,
      confidence REAL,
      category TEXT,
      reasoning TEXT
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      parentId TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      ts INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      lat REAL,
      lng REAL,
      exitTs INTEGER,
      dwellMin REAL,
      escalationDueTs INTEGER,
      pickupConfirmed INTEGER DEFAULT 0,
      dropoffConfirmed INTEGER DEFAULT 0,
      timeline_json TEXT,
      pt01Eligible INTEGER DEFAULT 0,
      triage_json TEXT
    );

    CREATE TABLE IF NOT EXISTS dispatches (
      id TEXT PRIMARY KEY,
      incidentId TEXT NOT NULL,
      status TEXT NOT NULL,
      driver_json TEXT,
      etaMin REAL,
      lat REAL,
      lng REAL,
      retryCount INTEGER DEFAULT 0,
      idempotencyKey TEXT,
      createdTs INTEGER
    );

    CREATE TABLE IF NOT EXISTS care_requests (
      id TEXT PRIMARY KEY,
      parentId TEXT NOT NULL,
      needSummary TEXT,
      windows_json TEXT,
      channelStatus_json TEXT,
      slaDueTs INTEGER,
      plan_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS settlements (
      id TEXT PRIMARY KEY,
      parentId TEXT NOT NULL,
      period TEXT NOT NULL,
      lines_json TEXT NOT NULL,
      pt03Credit REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS attestations (
      id TEXT PRIMARY KEY,
      policyId TEXT,
      triggerCode TEXT,
      payoutAmount REAL,
      recipient TEXT,
      timestamp INTEGER,
      triggerRef TEXT,
      coverageCode TEXT,
      monthKey TEXT,
      payloadHash TEXT,
      signature TEXT,
      signer TEXT,
      source TEXT,
      txHash TEXT,
      status TEXT,
      attesterNonce TEXT
    );

    CREATE TABLE IF NOT EXISTS cap_ledger (
      id TEXT PRIMARY KEY,
      coverageCode TEXT NOT NULL,
      monthKey TEXT NOT NULL,
      amount REAL NOT NULL,
      attestationId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      parentId TEXT PRIMARY KEY,
      singleton_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallets (
      name TEXT PRIMARY KEY,
      address TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parentId TEXT,
      type TEXT NOT NULL,
      ts INTEGER NOT NULL,
      title TEXT NOT NULL,
      deepLink TEXT,
      refId TEXT
    );

    CREATE TABLE IF NOT EXISTS households (
      householdId TEXT PRIMARY KEY,
      customerId TEXT UNIQUE,
      originalQuoteId TEXT,
      smartContractId TEXT,
      policyNumber TEXT,
      policyStatus TEXT,
      insuredDisplayName TEXT,
      insuredDobHash TEXT,
      coveragesJson TEXT,
      createdAt INTEGER,
      lastReconciledAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS devices (
      deviceId TEXT PRIMARY KEY,
      householdId TEXT NOT NULL,
      role TEXT NOT NULL,
      deviceTokenHash TEXT,
      pushToken TEXT,
      activatedAt INTEGER,
      lastSeen INTEGER,
      revokedAt INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS devices_household_role_active
      ON devices(householdId, role) WHERE revokedAt IS NULL;

    CREATE TABLE IF NOT EXISTS activations (
      activationId TEXT PRIMARY KEY,
      deviceId TEXT,
      role TEXT,
      householdId TEXT,
      state TEXT NOT NULL,
      createdAt INTEGER,
      expiresAt INTEGER
    );

    CREATE TABLE IF NOT EXISTS activation_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      policyNumberHash TEXT,
      deviceId TEXT,
      ip TEXT,
      outcome TEXT,
      ts INTEGER
    );
  `);

  // householdId is a new, denormalized column added alongside the existing parentId on the
  // parentId-keyed tables — parentId itself is never touched. better-sqlite3/SQLite has no
  // `ADD COLUMN IF NOT EXISTS`, so guard each addition with a PRAGMA table_info check.
  for (const table of ['metrics', 'frs_history', 'incidents', 'care_requests', 'settlements']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === 'householdId')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN householdId TEXT`);
    }
  }

  // attesterNonce holds Protosure's own signing nonce (routes/payments.js#preTransferHash) —
  // distinct from triggerRef, which remains the on-chain dedup key. Added after `attestations`
  // already shipped, so guard the same way as householdId above.
  const attestationCols = db.prepare(`PRAGMA table_info(attestations)`).all();
  if (!attestationCols.some((c) => c.name === 'attesterNonce')) {
    db.exec(`ALTER TABLE attestations ADD COLUMN attesterNonce TEXT`);
  }
}

export function appendEvent(db, { parentId = null, type, title, deepLink = null, refId = null, ts = Date.now() }) {
  db.prepare(
    `INSERT INTO events (parentId, type, ts, title, deepLink, refId) VALUES (?,?,?,?,?,?)`
  ).run(parentId, type, ts, title, deepLink, refId);
}

export function isEmpty(db) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM metrics').get();
  return row.c === 0;
}

// Wipes demo data but never touches `wallets` (chain contract addresses persist across resets)
// or `cap_ledger` (mirrors on-chain monthSpend, which a demo reset never touches either — wiping
// the local ledger but not the chain would let the pre-check drift out of sync with reality).
// `households` is likewise never wiped — same rationale: the customerId/household identity is
// meant to persist across a demo reset so judges don't have to re-activate from scratch every
// time, they only need `devices`/`activations`/`activation_attempts` cleared so activation can be
// re-run.
const WIPE_TABLES = [
  'metrics',
  'frs_history',
  'frs_reviews',
  'incidents',
  'dispatches',
  'care_requests',
  'settlements',
  'attestations',
  'settings',
  'events',
  'devices',
  'activations',
  'activation_attempts',
];

export function wipe(db) {
  const txn = db.transaction(() => {
    for (const t of WIPE_TABLES) db.prepare(`DELETE FROM ${t}`).run();
  });
  txn();
}

function defaultSettings(parentId, overrides = {}) {
  return {
    parentId,
    pairingStatus: 'connected',
    sharingEnabled: true,
    homeLatLng: { ...HOME },
    geofenceRadius: 500,
    monitoringActive: true,
    configVersion: 1,
    updatedAt: Date.now(),
    updatedBy: 'sakura',
    knownSafePlaces: [
      { name: 'サンライズスーパー', lat: 35.6612, lng: 139.7031 },
      { name: '田中クリニック', lat: 35.658, lng: 139.6988 },
    ],
    chips: {
      careNetwork: 'auto',
      careChannel: 'auto',
      triageMode: 'auto',
      frsReviewMode: 'auto',
    },
    ...overrides,
  };
}

function seedMetricsFor(db, parentId, days, baseDate) {
  const rows = [];
  for (let i = days.length - 1; i >= 0; i--) {
    const d = new Date(baseDate);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    rows.push({ date, ...days[days.length - 1 - i] });
  }
  const insert = db.prepare(
    `INSERT INTO metrics (parentId, date, dailySteps, sleepHours, heartRateAvg, heartRateResting, ts)
     VALUES (@parentId, @date, @dailySteps, @sleepHours, @heartRateAvg, @heartRateResting, @ts)`
  );
  const insertFrs = db.prepare(
    `INSERT INTO frs_history (parentId, date, score, factors_json) VALUES (?,?,?,?)`
  );
  const historySteps = [];
  const txn = db.transaction(() => {
    for (const row of rows) {
      insert.run({ parentId, ts: Date.now(), ...row });
      const frs = computeFRS({ today: row, historySteps: [...historySteps] });
      insertFrs.run(parentId, row.date, frs.score, JSON.stringify(frs.factors));
      historySteps.push(row.dailySteps);
    }
  });
  txn();
}

export function seed(db) {
  const today = new Date();

  // yoshiko-001: full 7-day history, today deliberately shy of a perfect score (~low 80s)
  // so judges see FRS movement rather than a maxed-out demo number.
  seedMetricsFor(
    db,
    DEFAULT_PARENT_ID,
    [
      { dailySteps: 3400, sleepHours: 6.2, heartRateAvg: 75, heartRateResting: 70 },
      { dailySteps: 5200, sleepHours: 7.8, heartRateAvg: 74, heartRateResting: 66 },
      { dailySteps: 4600, sleepHours: 7.1, heartRateAvg: 76, heartRateResting: 68 },
      { dailySteps: 3900, sleepHours: 6.9, heartRateAvg: 73, heartRateResting: 65 },
      { dailySteps: 4800, sleepHours: 7.4, heartRateAvg: 75, heartRateResting: 67 },
      { dailySteps: 4100, sleepHours: 6.6, heartRateAvg: 72, heartRateResting: 64 },
      { dailySteps: 2900, sleepHours: 6.3, heartRateAvg: 82, heartRateResting: 78 }, // today
    ],
    today
  );

  // yoshiko-002: sparse, partial history — a "clean" second family for a fresh judge run.
  seedMetricsFor(
    db,
    SECOND_PARENT_ID,
    [
      { dailySteps: 5400, sleepHours: 7.6, heartRateAvg: 70, heartRateResting: 62 },
      { dailySteps: 6100, sleepHours: 7.9, heartRateAvg: 69, heartRateResting: 60 },
    ],
    today
  );

  const upsertSettings = db.prepare(
    `INSERT INTO settings (parentId, singleton_json) VALUES (?, ?)`
  );
  upsertSettings.run(
    DEFAULT_PARENT_ID,
    JSON.stringify(
      defaultSettings(DEFAULT_PARENT_ID, {
        // Same relative offsets from home as the shared default, re-centered on Akita — keeps
        // movingTowardSafePlace (src/routes/incidents.js) meaningful after the move.
        knownSafePlaces: [
          { name: 'サンライズスーパー', lat: 39.7203, lng: 140.105 },
          { name: '田中クリニック', lat: 39.7171, lng: 140.1007 },
        ],
      })
    )
  );
  upsertSettings.run(
    SECOND_PARENT_ID,
    JSON.stringify(
      defaultSettings(SECOND_PARENT_ID, {
        homeLatLng: { lat: 35.71, lng: 139.81 },
      })
    )
  );

  const juneLines = [
    {
      lineId: 'L1',
      type: 'visit',
      description: '訪問介護 — Kenji T., 2026-06-05',
      amount: 3000,
      attested: true,
      disputed: false,
      ts: Date.UTC(2026, 5, 5),
    },
    {
      lineId: 'L2',
      type: 'visit',
      description: '訪問介護 — Aiko M., 2026-06-12',
      amount: 3000,
      attested: true,
      disputed: false,
      ts: Date.UTC(2026, 5, 12),
    },
    {
      lineId: 'L3',
      type: 'visit',
      description: '訪問介護 — Kenji T., 2026-06-20',
      amount: 3000,
      attested: true,
      disputed: false,
      ts: Date.UTC(2026, 5, 20),
    },
    {
      lineId: 'L4',
      type: 'reward',
      description: '徘徊対応報酬（保留中）',
      amount: 3000,
      attested: false,
      disputed: false,
      ts: Date.UTC(2026, 5, 28),
    },
  ];
  db.prepare(
    `INSERT INTO settlements (id, parentId, period, lines_json, pt03Credit) VALUES (?,?,?,?,?)`
  ).run(
    'settlement-2026-06',
    DEFAULT_PARENT_ID,
    '2026-06',
    JSON.stringify(juneLines),
    9000
  );

  db.prepare(`INSERT OR IGNORE INTO wallets (name, address) VALUES (?, ?)`).run(
    'payoutPool',
    process.env.PAYOUT_ADDR || null
  );
  db.prepare(`INSERT OR IGNORE INTO wallets (name, address) VALUES (?, ?)`).run(
    'sakura',
    process.env.SAKURA_WALLET_ADDR || null
  );

  appendEvent(db, {
    parentId: DEFAULT_PARENT_ID,
    type: 'settlement',
    title: 'June settlement ready for review',
    deepLink: '/v1/settlement/current',
    refId: 'settlement-2026-06',
  });

  // Seed household: householdId reuses the DEFAULT_PARENT_ID literal so the demo's
  // parentId <-> householdId mapping is trivially 1:1 — no separate lookup table needed for the
  // existing single-household-per-parent demo shape.
  db.prepare(
    `INSERT OR IGNORE INTO households
       (householdId, customerId, originalQuoteId, smartContractId, policyNumber, policyStatus, insuredDisplayName, insuredDobHash, coveragesJson, createdAt, lastReconciledAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    DEFAULT_PARENT_ID,
    'CUST-DEMO-001',
    'QT-2026-000481',
    'SC-FUJI-0001',
    'KP-2026-001',
    'in_force',
    'Yoshiko Tanaka',
    null,
    JSON.stringify([]),
    Date.now(),
    null
  );

  for (const table of ['metrics', 'frs_history', 'incidents', 'care_requests', 'settlements']) {
    db.prepare(`UPDATE ${table} SET householdId = parentId WHERE householdId IS NULL`).run();
  }
}

export function seedIfEmpty(db) {
  if (isEmpty(db)) seed(db);
}

export function resetDb(db) {
  wipe(db);
  seed(db);
}

// req.household is set by requireDevice (src/auth.js) when a valid device token is presented —
// it wins over any client-supplied parentId so a device can't spoof another household's data.
// Falls back to today's query/body param behavior when no device token is presented, keeping
// every pre-activation demo/test workflow unchanged.
export function getParentId(req) {
  return req.household?.parentId || req.query.parentId || req.body?.parentId || DEFAULT_PARENT_ID;
}

export function getSettings(db, parentId) {
  const row = db.prepare('SELECT singleton_json FROM settings WHERE parentId = ?').get(parentId);
  if (!row) {
    const fresh = defaultSettings(parentId);
    db.prepare(`INSERT INTO settings (parentId, singleton_json) VALUES (?, ?)`).run(
      parentId,
      JSON.stringify(fresh)
    );
    return fresh;
  }
  return JSON.parse(row.singleton_json);
}

export function saveSettings(db, parentId, settings) {
  db.prepare(
    `INSERT INTO settings (parentId, singleton_json) VALUES (?, ?)
     ON CONFLICT(parentId) DO UPDATE SET singleton_json = excluded.singleton_json`
  ).run(parentId, JSON.stringify(settings));
}
