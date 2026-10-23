/** Demo platform schema: one SQLite database for accounts, offers, orders, the demo clock and the mock neocloud. */

export const SCHEMA_VERSION = 1;

const stamps = `created_at TEXT NOT NULL, updated_at TEXT NOT NULL`;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, ${stamps})`,
  `CREATE TABLE IF NOT EXISTS neoclouds (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, regions_json TEXT NOT NULL DEFAULT '[]',
    auto_confirm INTEGER NOT NULL DEFAULT 1, webhook_url TEXT NOT NULL DEFAULT '',
    api_key_hash TEXT, api_key_last4 TEXT, owner_account_id TEXT, ${stamps})`,
  `CREATE TABLE IF NOT EXISTS capacity (
    neocloud_id TEXT NOT NULL REFERENCES neoclouds(id) ON DELETE CASCADE, gpu TEXT NOT NULL, region TEXT NOT NULL,
    total INTEGER NOT NULL, ${stamps}, PRIMARY KEY (neocloud_id, gpu, region))`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, company TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('buyer','lender','provider','admin')),
    kyb TEXT NOT NULL DEFAULT 'pending' CHECK (kyb IN ('pending','verified','rejected')),
    stage TEXT NOT NULL DEFAULT 'demo' CHECK (stage IN ('lead','demo','kyb','active','churned')),
    phone TEXT NOT NULL DEFAULT '', demo_now TEXT NOT NULL,
    scenario TEXT NOT NULL DEFAULT 'market' CHECK (scenario IN ('market','rise','fall','spike','flat')),
    neocloud_id TEXT REFERENCES neoclouds(id), seed_key TEXT, last_active_at TEXT, ${stamps})`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL, ${stamps})`,
  `CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    author TEXT NOT NULL, text TEXT NOT NULL, ${stamps})`,
  `CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY, neocloud_id TEXT NOT NULL REFERENCES neoclouds(id), gpu TEXT NOT NULL, config TEXT NOT NULL,
    region TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('cap','floor','lock')), start TEXT NOT NULL, end TEXT NOT NULL,
    strike REAL NOT NULL, premium_per_gpu_hour REAL NOT NULL, min_gpus INTEGER NOT NULL, max_gpus INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '', ${stamps})`,
  `CREATE TABLE IF NOT EXISTS orders (
    ref TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, offer_id TEXT,
    neocloud_id TEXT NOT NULL REFERENCES neoclouds(id), gpu TEXT NOT NULL, config TEXT NOT NULL, region TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('cap','floor','lock')), count INTEGER NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
    strike REAL NOT NULL, premium_per_gpu_hour REAL NOT NULL, premium_total REAL NOT NULL, platform_fee REAL NOT NULL,
    booking_fee REAL NOT NULL, pay_now REAL NOT NULL, gpu_hours REAL NOT NULL, compute_cost_if_used REAL,
    break_even REAL, status TEXT NOT NULL, status_reason TEXT, delivery_choice TEXT NOT NULL DEFAULT 'deliver',
    listing_json TEXT, resold_to_json TEXT, settlement_json TEXT, notified_json TEXT NOT NULL DEFAULT '[]',
    usage_until TEXT, next_bid_at TEXT, reserve_requested_at TEXT, paid_at TEXT, meta_json TEXT NOT NULL DEFAULT '{}',
    ordered_at TEXT NOT NULL, ${stamps})`,
  `CREATE TABLE IF NOT EXISTS bids (
    id TEXT PRIMARY KEY, order_ref TEXT NOT NULL REFERENCES orders(ref) ON DELETE CASCADE, bidder TEXT NOT NULL,
    price_per_hour REAL NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, ${stamps})`,
  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, order_ref TEXT NOT NULL REFERENCES orders(ref) ON DELETE CASCADE, account_id TEXT NOT NULL,
    amount REAL NOT NULL, brand TEXT, last4 TEXT, status TEXT NOT NULL, code TEXT, at TEXT NOT NULL, ${stamps})`,
  `CREATE TABLE IF NOT EXISTS payouts (
    id TEXT PRIMARY KEY, order_ref TEXT NOT NULL REFERENCES orders(ref) ON DELETE CASCADE, account_id TEXT NOT NULL,
    neocloud_id TEXT NOT NULL, direction TEXT NOT NULL, amount REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('scheduled','paid')), due_at TEXT NOT NULL, paid_at TEXT, ${stamps})`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, order_ref TEXT, account_id TEXT, neocloud_id TEXT, direction TEXT NOT NULL, type TEXT NOT NULL,
    payload_json TEXT NOT NULL, http_status INTEGER NOT NULL DEFAULT 200, at TEXT NOT NULL, seq INTEGER NOT NULL, ${stamps})`,
  `CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, to_addr TEXT NOT NULL,
    subject TEXT NOT NULL, body TEXT NOT NULL, order_ref TEXT, at TEXT NOT NULL, seq INTEGER NOT NULL, ${stamps})`,
  `CREATE TABLE IF NOT EXISTS prints (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, gpu TEXT NOT NULL, scenario TEXT NOT NULL,
    date TEXT NOT NULL, price REAL NOT NULL, ${stamps}, PRIMARY KEY (account_id, gpu, date))`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, ${stamps})`,
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS orders_account ON orders(account_id, created_at)',
  'CREATE INDEX IF NOT EXISTS orders_neocloud ON orders(neocloud_id, status)',
  'CREATE INDEX IF NOT EXISTS events_order ON events(order_ref, seq)',
  'CREATE INDEX IF NOT EXISTS events_neocloud ON events(neocloud_id, seq)',
  'CREATE INDEX IF NOT EXISTS emails_account ON emails(account_id, seq)',
  'CREATE INDEX IF NOT EXISTS payouts_order ON payouts(order_ref)',
  'CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id)',
  'CREATE INDEX IF NOT EXISTS notes_account ON notes(account_id, created_at)',
];

/** Creates every table and index if missing and records the schema version once. */
export function applySchema(db, nowIso = new Date().toISOString()) {
  for (const sql of [...TABLES, ...INDEXES]) db.exec(sql);
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
  if (!row) db.prepare('INSERT INTO schema_version (version, created_at, updated_at) VALUES (?, ?, ?)').run(SCHEMA_VERSION, nowIso, nowIso);
  else if (row.version > SCHEMA_VERSION) throw new Error('The demo database was created by a newer version of this server.');
}
