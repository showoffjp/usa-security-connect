import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.USC_DATA_DIR || path.resolve(__dirname, '../../data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const DB_PATH = path.join(DATA_DIR, 'usc.db');

const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA journal_mode = WAL');
raw.exec('PRAGMA foreign_keys = ON');

/**
 * Node 24 ships SQLite in core (`node:sqlite`), so the API needs no native
 * build step - a real advantage when deploying to a plain Node host.
 *
 * This thin adapter gives it the synchronous `prepare/run/get/all` +
 * `transaction()` shape the rest of the codebase is written against, and
 * normalises the two binding quirks: SQLite has no boolean type, and it
 * rejects `undefined`.
 */
function bindable(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString().replace('T', ' ').slice(0, 19);
    return p;
  });
}

const toNumber = (v) => (typeof v === 'bigint' ? Number(v) : v);

export const db = {
  prepare(sql) {
    const stmt = raw.prepare(sql);
    return {
      run: (...params) => {
        const r = stmt.run(...bindable(params));
        return { changes: toNumber(r.changes), lastInsertRowid: toNumber(r.lastInsertRowid) };
      },
      get: (...params) => stmt.get(...bindable(params)),
      all: (...params) => stmt.all(...bindable(params)),
    };
  },
  exec: (sql) => raw.exec(sql),
  /** Mirrors better-sqlite3's transaction(): returns a callable that is atomic. */
  transaction(fn) {
    return (...args) => {
      raw.exec('BEGIN');
      try {
        const result = fn(...args);
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* the transaction was already rolled back by SQLite */
        }
        throw err;
      }
    };
  },
  pragma: (statement) => raw.exec(`PRAGMA ${statement}`),
  close: () => raw.close(),
};

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    client_name TEXT,
    address TEXT,
    city TEXT, state TEXT DEFAULT 'FL', postal_code TEXT,
    latitude REAL, longitude REAL,
    timezone TEXT DEFAULT 'America/New_York',
    contact_name TEXT, contact_phone TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    post_code TEXT,
    instructions TEXT,
    latitude REAL, longitude REAL,
    geofence_radius_m INTEGER DEFAULT 150,
    check_in_interval_min INTEGER DEFAULT 60,
    requires_gps INTEGER NOT NULL DEFAULT 1,
    armed INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_code TEXT NOT NULL UNIQUE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT, phone TEXT,
    role TEXT NOT NULL DEFAULT 'officer',
    pin_hash TEXT, pin_salt TEXT, pin_set_at TEXT,
    must_change_pin INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',
    hire_date TEXT,
    license_number TEXT, license_type TEXT, license_expires_on TEXT,
    emergency_contact_name TEXT, emergency_contact_phone TEXT,
    default_site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    pay_rate_cents INTEGER,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    last_login_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_code ON users(employee_code);

  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_shifts_user_time ON shifts(user_id, starts_at);
  CREATE INDEX IF NOT EXISTS idx_shifts_time ON shifts(starts_at);

  CREATE TABLE IF NOT EXISTS time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    clock_in_at TEXT NOT NULL,
    clock_in_lat REAL, clock_in_lng REAL, clock_in_accuracy REAL,
    clock_in_geofence TEXT,
    clock_in_distance_m INTEGER,
    clock_out_at TEXT,
    clock_out_lat REAL, clock_out_lng REAL, clock_out_accuracy REAL,
    clock_out_geofence TEXT,
    method TEXT NOT NULL DEFAULT 'gps',
    device_id TEXT,
    minutes_worked INTEGER,
    late_minutes INTEGER DEFAULT 0,
    auto_closed INTEGER NOT NULL DEFAULT 0,
    adjusted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    adjustment_reason TEXT,
    original_clock_in_at TEXT, original_clock_out_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_entries_user ON time_entries(user_id, clock_in_at);
  CREATE INDEX IF NOT EXISTS idx_entries_open ON time_entries(clock_out_at);

  CREATE TABLE IF NOT EXISTS status_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time_entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    due_at TEXT NOT NULL,
    window_minutes INTEGER NOT NULL DEFAULT 10,
    responded_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    latitude REAL, longitude REAL,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_checks_entry ON status_checks(time_entry_id, due_at);
  CREATE INDEX IF NOT EXISTS idx_checks_pending ON status_checks(status, due_at);

  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_number TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    tour_run_id INTEGER,
    checkpoint_id INTEGER,
    officer_name TEXT,
    callback_number TEXT,
    category TEXT,
    severity TEXT NOT NULL DEFAULT 'low',
    occurred_at TEXT NOT NULL,
    location_text TEXT,
    what_happened TEXT NOT NULL,
    resolution TEXT,
    other_details TEXT,
    people_involved TEXT,
    people_notified TEXT,
    police_notified INTEGER NOT NULL DEFAULT 0,
    police_report_number TEXT,
    cost_recovery_cents INTEGER,
    status TEXT NOT NULL DEFAULT 'submitted',
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TEXT,
    review_notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_incidents_time ON incidents(occurred_at);

  CREATE TABLE IF NOT EXISTS incident_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    original_name TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    caption TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS supervisor_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supervisor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    officer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    visited_at TEXT NOT NULL,
    uniform_ok INTEGER, post_orders_reviewed INTEGER, equipment_ok INTEGER, site_secure INTEGER,
    rating INTEGER,
    notes TEXT,
    latitude REAL, longitude REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    expected_minutes INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tour_id INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    nfc_tag_id TEXT, qr_code TEXT,
    latitude REAL, longitude REAL,
    instructions TEXT,
    required INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_checkpoints_tour ON checkpoints(tour_id, sequence);

  CREATE TABLE IF NOT EXISTS checkpoint_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    required INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS tour_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tour_id INTEGER NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    time_entry_id INTEGER REFERENCES time_entries(id) ON DELETE SET NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress'
  );

  CREATE TABLE IF NOT EXISTS tour_run_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tour_run_id INTEGER NOT NULL REFERENCES tour_runs(id) ON DELETE CASCADE,
    checkpoint_id INTEGER NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    scanned_at TEXT,
    method TEXT,
    latitude REAL, longitude REAL,
    skip_reason TEXT
  );

  CREATE TABLE IF NOT EXISTS tour_run_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tour_run_checkpoint_id INTEGER NOT NULL REFERENCES tour_run_checkpoints(id) ON DELETE CASCADE,
    checkpoint_task_id INTEGER NOT NULL REFERENCES checkpoint_tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    requires_ack INTEGER NOT NULL DEFAULT 0,
    audience_role TEXT,
    audience_site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    published_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS broadcast_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TEXT, acknowledged_at TEXT,
    UNIQUE(broadcast_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS trainings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    video_url TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    required INTEGER NOT NULL DEFAULT 0,
    due_at TEXT,
    audience_role TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS training_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seconds_watched INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    UNIQUE(training_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_message_at TEXT
  );

  CREATE TABLE IF NOT EXISTS thread_participants (
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at TEXT,
    PRIMARY KEY (thread_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, sent_at);

  CREATE TABLE IF NOT EXISTS flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    occurred_at TEXT NOT NULL,
    ref_type TEXT, ref_id INTEGER,
    detail TEXT,
    resolved_at TEXT,
    resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolution_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(type, ref_type, ref_id)
  );
  CREATE INDEX IF NOT EXISTS idx_flags_open ON flags(resolved_at, occurred_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity TEXT, entity_id INTEGER,
    detail TEXT,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);

  CREATE TABLE IF NOT EXISTS device_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    platform TEXT,
    device_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_device_user ON device_tokens(user_id);

  /* Licences and certifications, tracked so nobody works an armed post on a
     lapsed Class G. */
  CREATE TABLE IF NOT EXISTS certifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    number TEXT,
    issuing_authority TEXT,
    issued_on TEXT,
    expires_on TEXT,
    document_filename TEXT,
    verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    verified_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_certs_user ON certifications(user_id);
  CREATE INDEX IF NOT EXISTS idx_certs_expiry ON certifications(expires_on);

  /* When an officer is willing to work. Used to warn before assigning a shift. */
  CREATE TABLE IF NOT EXISTS availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    weekday INTEGER NOT NULL,
    start_time TEXT NOT NULL DEFAULT '00:00',
    end_time TEXT NOT NULL DEFAULT '23:59',
    available INTEGER NOT NULL DEFAULT 1,
    note TEXT,
    UNIQUE(user_id, weekday)
  );

  CREATE TABLE IF NOT EXISTS time_off_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'vacation',
    starts_on TEXT NOT NULL,
    ends_on TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decided_at TEXT,
    decision_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_timeoff_user ON time_off_requests(user_id, starts_on);
  CREATE INDEX IF NOT EXISTS idx_timeoff_status ON time_off_requests(status);

  /* Meal and rest breaks. Unpaid meal time is deducted from the shift. */
  CREATE TABLE IF NOT EXISTS breaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time_entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'meal',
    paid INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    minutes INTEGER,
    start_lat REAL, start_lng REAL
  );
  CREATE INDEX IF NOT EXISTS idx_breaks_entry ON breaks(time_entry_id);

  /* Duress button. A lone officer's most important feature. */
  CREATE TABLE IF NOT EXISTS panic_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    time_entry_id INTEGER REFERENCES time_entries(id) ON DELETE SET NULL,
    post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
    latitude REAL, longitude REAL, accuracy REAL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    acknowledged_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    acknowledged_at TEXT,
    resolved_at TEXT,
    resolution_note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_panic_status ON panic_alerts(status, triggered_at);
  `);

  // Columns added after the first release. CREATE TABLE IF NOT EXISTS will not
  // add them to a database that already exists, so they are applied here.
  addColumn('status_checks', 'notified_at', 'TEXT');
  addColumn('flags', 'notified_at', 'TEXT');

  /* --- employment classification, pay and billing --- */
  addColumn('users', 'employment_type', `TEXT NOT NULL DEFAULT 'w2'`);
  addColumn('users', 'pay_type', `TEXT NOT NULL DEFAULT 'hourly'`);
  addColumn('users', 'exempt', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'overtime_multiplier', 'REAL NOT NULL DEFAULT 1.5');
  addColumn('users', 'salary_cents', 'INTEGER');
  // What the client is charged for this officer's hours - drives margin.
  addColumn('users', 'bill_rate_cents', 'INTEGER');

  /* --- 1099 contractor paperwork --- */
  addColumn('users', 'business_name', 'TEXT');
  // Only the last four digits of an EIN/SSN are kept; the full number belongs
  // in the payroll system, not here.
  addColumn('users', 'tax_id_last4', 'TEXT');
  addColumn('users', 'w9_on_file', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'contractor_agreement_on_file', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'insurance_expires_on', 'TEXT');

  /* --- profile --- */
  addColumn('users', 'address_line1', 'TEXT');
  addColumn('users', 'address_line2', 'TEXT');
  addColumn('users', 'city', 'TEXT');
  addColumn('users', 'state', 'TEXT');
  addColumn('users', 'postal_code', 'TEXT');
  addColumn('users', 'uniform_size', 'TEXT');
  addColumn('users', 'avatar_filename', 'TEXT');
  addColumn('users', 'emergency_contact_relation', 'TEXT');

  /* --- shift extras --- */
  addColumn('shifts', 'bill_rate_cents', 'INTEGER');
  addColumn('shifts', 'is_open', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('time_entries', 'unpaid_break_minutes', 'INTEGER NOT NULL DEFAULT 0');

  /* --- site/post addressing for map display --- */
  addColumn('posts', 'address', 'TEXT');
  addColumn('posts', 'what3words', 'TEXT');
}

/** Add a column only if it is missing, so migrate() stays safe to re-run. */
function addColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!existing.length) return;
  if (existing.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function audit(actorId, action, entity, entityId, detail, ip) {
  db.prepare(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, detail, ip)
     VALUES (?,?,?,?,?,?)`
  ).run(
    actorId ?? null,
    action,
    entity ?? null,
    entityId ?? null,
    detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null,
    ip ?? null
  );
}
