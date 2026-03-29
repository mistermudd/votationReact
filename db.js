const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const configuredPath = String(process.env.DB_PATH || '').trim();
const dbPath = configuredPath ? path.resolve(configuredPath) : path.join(__dirname, 'votation.db');
const dbDir = path.dirname(dbPath);
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS lineup (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist_name TEXT NOT NULL,
    song_title TEXT,
    performance_order INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lineup_id INTEGER NOT NULL,
    is_open INTEGER NOT NULL DEFAULT 1,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    FOREIGN KEY (lineup_id) REFERENCES lineup(id)
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lineup_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('judge', 'public')),
    voter_name TEXT NOT NULL,
    score INTEGER NOT NULL CHECK(score >= 1 AND score <= 10),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    UNIQUE(lineup_id, role, voter_name),
    FOREIGN KEY (lineup_id) REFERENCES lineup(id)
  );

  CREATE TABLE IF NOT EXISTS runoff_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_lineup_id INTEGER NOT NULL,
    second_lineup_id INTEGER NOT NULL,
    is_open INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT,
    FOREIGN KEY (first_lineup_id) REFERENCES lineup(id),
    FOREIGN KEY (second_lineup_id) REFERENCES lineup(id)
  );

  CREATE TABLE IF NOT EXISTS runoff_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runoff_session_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('judge', 'public')),
    voter_name TEXT NOT NULL,
    selected_lineup_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(runoff_session_id, role, voter_name),
    FOREIGN KEY (runoff_session_id) REFERENCES runoff_sessions(id),
    FOREIGN KEY (selected_lineup_id) REFERENCES lineup(id)
  );
`);

module.exports = db;
