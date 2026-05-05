const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_lUAapFW7crz9@ep-patient-waterfall-ab83mkzo.eu-west-2.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

pool.query(`
  CREATE TABLE IF NOT EXISTS lineup (
    id SERIAL PRIMARY KEY,
    artist_name TEXT NOT NULL,
    song_title TEXT,
    performance_order INTEGER NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    lineup_id INTEGER NOT NULL REFERENCES lineup(id),
    is_open BOOLEAN NOT NULL DEFAULT TRUE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS votes (
    id SERIAL PRIMARY KEY,
    lineup_id INTEGER NOT NULL REFERENCES lineup(id),
    role TEXT NOT NULL CHECK(role IN ('judge', 'public')),
    voter_name TEXT NOT NULL,
    score INTEGER NOT NULL CHECK(score >= 1 AND score <= 10),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ,
    UNIQUE(lineup_id, role, voter_name)
  );

  CREATE TABLE IF NOT EXISTS runoff_sessions (
    id SERIAL PRIMARY KEY,
    first_lineup_id INTEGER NOT NULL REFERENCES lineup(id),
    second_lineup_id INTEGER NOT NULL REFERENCES lineup(id),
    is_open BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS runoff_votes (
    id SERIAL PRIMARY KEY,
    runoff_session_id INTEGER NOT NULL REFERENCES runoff_sessions(id),
    role TEXT NOT NULL CHECK(role IN ('judge', 'public')),
    voter_name TEXT NOT NULL,
    selected_lineup_id INTEGER NOT NULL REFERENCES lineup(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(runoff_session_id, role, voter_name)
  );
`).catch((err) => {
  console.error('Errore inizializzazione DB:', err.message);
  process.exit(1);
});

module.exports = pool;
