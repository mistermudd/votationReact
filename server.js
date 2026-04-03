const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const GITHUB_BACKUP_TOKEN = process.env.GITHUB_BACKUP_TOKEN || '';
const GITHUB_BACKUP_GIST_ID = process.env.GITHUB_BACKUP_GIST_ID || '';
const BACKUP_INTERVAL_MS = 10 * 60 * 1000; // ogni 10 minuti

async function backupToGist() {
  if (!GITHUB_BACKUP_TOKEN || !GITHUB_BACKUP_GIST_ID) return false;
  try {
    const data = {
      backed_up_at: new Date().toISOString(),
      lineup: db.prepare('SELECT * FROM lineup').all(),
      sessions: db.prepare('SELECT * FROM sessions').all(),
      votes: db.prepare('SELECT * FROM votes').all(),
      runoff_sessions: db.prepare('SELECT * FROM runoff_sessions').all(),
      runoff_votes: db.prepare('SELECT * FROM runoff_votes').all()
    };
    const response = await fetch(`https://api.github.com/gists/${GITHUB_BACKUP_GIST_ID}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${GITHUB_BACKUP_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'votation-backup'
      },
      body: JSON.stringify({
        files: { 'votation-backup.json': { content: JSON.stringify(data, null, 2) } }
      })
    });
    if (response.ok) {
      console.log('[backup] Backup Gist completato:', data.backed_up_at);
      return true;
    }
    console.error('[backup] Gist PATCH fallito:', response.status);
    return false;
  } catch (err) {
    console.error('[backup] Errore backup Gist:', err.message);
    return false;
  }
}

async function restoreFromGist() {
  if (!GITHUB_BACKUP_TOKEN || !GITHUB_BACKUP_GIST_ID) return;
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM lineup').get();
  if (count.cnt > 0) {
    console.log('[backup] DB non vuoto, ripristino saltato.');
    return;
  }
  try {
    const response = await fetch(`https://api.github.com/gists/${GITHUB_BACKUP_GIST_ID}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_BACKUP_TOKEN}`,
        'User-Agent': 'votation-backup'
      }
    });
    if (!response.ok) {
      console.error('[backup] Lettura Gist fallita:', response.status);
      return;
    }
    const gist = await response.json();
    const file = gist.files && gist.files['votation-backup.json'];
    if (!file || !file.content) {
      console.log('[backup] Nessun backup trovato nel Gist.');
      return;
    }
    const data = JSON.parse(file.content);
    const restore = db.transaction(() => {
      for (const r of data.lineup || []) {
        db.prepare(
          'INSERT OR IGNORE INTO lineup (id, artist_name, song_title, performance_order, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(r.id, r.artist_name, r.song_title, r.performance_order, r.created_at);
      }
      for (const r of data.sessions || []) {
        db.prepare(
          'INSERT OR IGNORE INTO sessions (id, lineup_id, is_open, started_at, ended_at) VALUES (?, ?, ?, ?, ?)'
        ).run(r.id, r.lineup_id, r.is_open, r.started_at, r.ended_at);
      }
      for (const r of data.votes || []) {
        db.prepare(
          'INSERT OR IGNORE INTO votes (id, lineup_id, role, voter_name, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(r.id, r.lineup_id, r.role, r.voter_name, r.score, r.created_at, r.updated_at);
      }
      for (const r of data.runoff_sessions || []) {
        db.prepare(
          'INSERT OR IGNORE INTO runoff_sessions (id, first_lineup_id, second_lineup_id, is_open, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(r.id, r.first_lineup_id, r.second_lineup_id, r.is_open, r.created_at, r.closed_at);
      }
      for (const r of data.runoff_votes || []) {
        db.prepare(
          'INSERT OR IGNORE INTO runoff_votes (id, runoff_session_id, role, voter_name, selected_lineup_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(r.id, r.runoff_session_id, r.role, r.voter_name, r.selected_lineup_id, r.created_at);
      }
    });
    restore();
    // Reset SQLite autoincrement sequences after bulk insert
    db.exec(`
      UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM lineup) WHERE name = 'lineup';
      UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM sessions) WHERE name = 'sessions';
      UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM votes) WHERE name = 'votes';
      UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM runoff_sessions) WHERE name = 'runoff_sessions';
      UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM runoff_votes) WHERE name = 'runoff_votes';
    `);
    console.log('[backup] Ripristino da Gist completato. Backed up at:', data.backed_up_at || 'N/A');
  } catch (err) {
    console.error('[backup] Errore ripristino Gist:', err.message);
  }
}

// Avvia ripristino async al boot (non blocca l'avvio del server)
restoreFromGist().catch(() => {});

// Backup periodico ogni 10 minuti
if (GITHUB_BACKUP_TOKEN && GITHUB_BACKUP_GIST_ID) {
  setInterval(() => backupToGist().catch(() => {}), BACKUP_INTERVAL_MS);
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const GESTIONE_USER = process.env.GESTIONE_USER || 'gestione';
const GESTIONE_PIN = process.env.GESTIONE_PIN || '5678';
const REGIA_USER = process.env.REGIA_USER || 'regia';
const REGIA_PIN = process.env.REGIA_PIN || '2468';
const ROLE_LABELS = {
  admin: 'Admin',
  gestione: 'Regia',
  regia: 'Giudice'
};

let allVotesCompleted = false;

function parseBasicAuth(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Basic ')) {
    return null;
  }

  try {
    const encoded = auth.slice(6);
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex < 0) {
      return null;
    }

    return {
      user: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    };
  } catch (_error) {
    return null;
  }
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  if (!header) {
    return {};
  }

  return header.split(';').reduce((acc, part) => {
    const item = part.trim();
    const index = item.indexOf('=');
    if (index < 0) {
      return acc;
    }

    const key = item.slice(0, index);
    const value = item.slice(index + 1);
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

const authSessions = new Map();

function createSession(role) {
  const token = crypto.randomBytes(24).toString('hex');
  authSessions.set(token, { role, createdAt: Date.now() });
  return token;
}

function getRoleFromToken(req) {
  const cookies = parseCookies(req);
  const token = cookies.auth_token;
  if (!token) {
    return null;
  }

  const session = authSessions.get(token);
  return session ? session.role : null;
}

function getAccessRole(req) {
  const sessionRole = getRoleFromToken(req);
  if (sessionRole) {
    return sessionRole;
  }

  const credentials = parseBasicAuth(req);
  if (!credentials) {
    return null;
  }

  const { user, password } = credentials;

  if (user === ADMIN_USER && password === ADMIN_PIN) {
    return 'admin';
  }

  if (user === GESTIONE_USER && password === GESTIONE_PIN) {
    return 'gestione';
  }

  if (user === REGIA_USER && password === REGIA_PIN) {
    return 'regia';
  }

  return null;
}

function denyAuth(res) {
  res.status(401).json({ error: 'Accesso non autorizzato' });
}

function denyAuthForRequest(req, res) {
  if (req.path.startsWith('/api/')) {
    denyAuth(res);
    return;
  }

  const redirectTo = `/login.html?next=${encodeURIComponent(req.path)}`;
  res.redirect(302, redirectTo);
}

function requireRoles(allowedRoles) {
  return (req, res, next) => {
    const role = getAccessRole(req);
    if (!role || !allowedRoles.includes(role)) {
      denyAuthForRequest(req, res);
      return;
    }

    req.accessRole = role;
    next();
  };
}

app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use((req, res, next) => {
  const role = getAccessRole(req);
  req.accessRole = role;

  const publicPages = new Set(['/', '/login.html', '/public.html', '/runoff-public.html']);
  const anyRolePages = new Set(['/index.html']);
  const gestionePages = new Set(['/director.html', '/report.html', '/lineup.html', '/runoff-manage.html', '/qr-access.html']);
  const regiaPages = new Set(['/judge.html', '/runoff-judge.html']);
  const adminPages = new Set(['/performance.html']);

  if (publicPages.has(req.path)) {
    next();
    return;
  }

  if (anyRolePages.has(req.path)) {
    if (!role) {
      denyAuthForRequest(req, res);
      return;
    }
    next();
    return;
  }

  if (gestionePages.has(req.path)) {
    if (role !== 'gestione' && role !== 'admin') {
      denyAuthForRequest(req, res);
      return;
    }
    next();
    return;
  }

  if (regiaPages.has(req.path)) {
    if (role !== 'regia' && role !== 'admin') {
      denyAuthForRequest(req, res);
      return;
    }
    next();
    return;
  }

  if (adminPages.has(req.path)) {
    if (role !== 'admin') {
      denyAuthForRequest(req, res);
      return;
    }
    next();
    return;
  }

  next();
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/auth/login', (req, res) => {
  const selectedRole = String(req.body.role || '').trim();
  const password = String(req.body.password || '').trim();

  if (!selectedRole || !password) {
    return res.status(400).json({ error: 'Ruolo e password obbligatori' });
  }

  let role = null;
  if (selectedRole === 'admin' && password === ADMIN_PIN) {
    role = 'admin';
  }

  if (selectedRole === 'gestione' && password === GESTIONE_PIN) {
    role = 'gestione';
  }

  if (selectedRole === 'regia' && password === REGIA_PIN) {
    role = 'regia';
  }

  if (!role) {
    return res.status(401).json({ error: 'Credenziali non valide' });
  }

  const token = createSession(role);
  res.setHeader('Set-Cookie', `auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
  return res.status(200).json({
    message: 'Login effettuato',
    role,
    displayRole: ROLE_LABELS[role] || role
  });
});

app.get('/api/auth/me', (req, res) => {
  const role = getAccessRole(req);
  if (!role) {
    return res.status(200).json({ authenticated: false });
  }

  return res.status(200).json({
    authenticated: true,
    role,
    displayRole: ROLE_LABELS[role] || role
  });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.auth_token) {
    authSessions.delete(cookies.auth_token);
  }

  res.setHeader('Set-Cookie', 'auth_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
  return res.status(200).json({ message: 'Logout effettuato' });
});

app.use(express.static(path.join(__dirname, 'public')));

function getActiveSession() {
  return db
    .prepare(
      `
      SELECT
        s.id AS session_id,
        s.lineup_id,
        s.is_open,
        s.started_at,
        s.ended_at,
        l.artist_name,
        l.song_title,
        l.performance_order
      FROM sessions s
      JOIN lineup l ON l.id = s.lineup_id
      WHERE s.ended_at IS NULL
      ORDER BY s.id DESC
      LIMIT 1
    `
    )
    .get();
}

function getLineup() {
  return db
    .prepare(
      `
      SELECT id, artist_name, song_title, performance_order, created_at
      FROM lineup
      ORDER BY performance_order ASC
    `
    )
    .all();
}

function getActiveRunoffSession() {
  return db
    .prepare(
      `
      SELECT
        rs.id,
        rs.first_lineup_id,
        rs.second_lineup_id,
        rs.is_open,
        rs.created_at,
        rs.closed_at,
        a.artist_name AS first_artist_name,
        a.song_title AS first_song_title,
        b.artist_name AS second_artist_name,
        b.song_title AS second_song_title
      FROM runoff_sessions rs
      JOIN lineup a ON a.id = rs.first_lineup_id
      JOIN lineup b ON b.id = rs.second_lineup_id
      WHERE rs.closed_at IS NULL
      ORDER BY rs.id DESC
      LIMIT 1
    `
    )
    .get();
}

function getRunoffVoteCounts(sessionId) {
  const rows = db
    .prepare(
      `
      SELECT
        selected_lineup_id,
        role,
        COUNT(*) AS total
      FROM runoff_votes
      WHERE runoff_session_id = ?
      GROUP BY selected_lineup_id, role
    `
    )
    .all(sessionId);

  const counts = {};
  rows.forEach((row) => {
    if (!counts[row.selected_lineup_id]) {
      counts[row.selected_lineup_id] = {
        judge: 0,
        public: 0,
        total: 0
      };
    }
    const role = row.role === 'judge' ? 'judge' : 'public';
    const value = Number(row.total || 0);
    counts[row.selected_lineup_id][role] = value;
    counts[row.selected_lineup_id].total += value;
  });

  return counts;
}

function buildRunoffState() {
  const session = getActiveRunoffSession();

  if (!session) {
    return {
      hasActiveRunoff: false,
      sessionId: null,
      isOpenForVoting: false,
      artists: [],
      totals: {},
      winnerLineupId: null
    };
  }

  const counts = getRunoffVoteCounts(session.id);
  const artists = [
    {
      lineupId: session.first_lineup_id,
      artistName: session.first_artist_name,
      performanceName: session.first_song_title || '',
      votes: counts[session.first_lineup_id] || { judge: 0, public: 0, total: 0 }
    },
    {
      lineupId: session.second_lineup_id,
      artistName: session.second_artist_name,
      performanceName: session.second_song_title || '',
      votes: counts[session.second_lineup_id] || { judge: 0, public: 0, total: 0 }
    }
  ];

  const winnerLineupId =
    artists[0].votes.total === artists[1].votes.total
      ? null
      : artists[0].votes.total > artists[1].votes.total
        ? artists[0].lineupId
        : artists[1].lineupId;

  return {
    hasActiveRunoff: true,
    sessionId: session.id,
    isOpenForVoting: Boolean(session.is_open),
    createdAt: session.created_at,
    artists,
    winnerLineupId
  };
}

function emitRunoffState(eventName) {
  const payload = buildRunoffState();
  io.emit('runoff:state', payload);
  if (eventName) {
    io.emit(eventName, payload);
  }
  return payload;
}

function closeActiveRunoffSession() {
  db.prepare(
    `
    UPDATE runoff_sessions
    SET is_open = 0,
        closed_at = datetime('now')
    WHERE closed_at IS NULL
  `
  ).run();
}

function runoffVoteExists({ sessionId, role, voterName }) {
  const existing = db
    .prepare(
      `
      SELECT id
      FROM runoff_votes
      WHERE runoff_session_id = ? AND role = ? AND lower(voter_name) = lower(?)
      LIMIT 1
    `
    )
    .get(sessionId, role, voterName);

  return Boolean(existing);
}

function getNextLineupRow(currentOrder) {
  if (currentOrder == null) {
    return db
      .prepare(
        `
        SELECT id, artist_name, song_title, performance_order
        FROM lineup
        ORDER BY performance_order ASC
        LIMIT 1
      `
      )
      .get();
  }

  return db
    .prepare(
      `
      SELECT id, artist_name, song_title, performance_order
      FROM lineup
      WHERE performance_order > ?
      ORDER BY performance_order ASC
      LIMIT 1
    `
    )
    .get(currentOrder);
}

function statsByLineupId(lineupId) {
  const byRole = db
    .prepare(
      `
      SELECT role, COUNT(*) AS count, ROUND(AVG(score), 2) AS average
      FROM votes
      WHERE lineup_id = ?
      GROUP BY role
    `
    )
    .all(lineupId);

  const totals = db
    .prepare(
      `
      SELECT COUNT(*) AS count, ROUND(AVG(score), 2) AS average
      FROM votes
      WHERE lineup_id = ?
    `
    )
    .get(lineupId);

  const roleStats = {
    judge: { count: 0, average: 0 },
    public: { count: 0, average: 0 }
  };

  byRole.forEach((item) => {
    roleStats[item.role] = {
      count: Number(item.count || 0),
      average: Number(item.average || 0)
    };
  });

  return {
    total: {
      count: Number(totals.count || 0),
      average: Number(totals.average || 0)
    },
    byRole: roleStats
  };
}

function buildStatePayload() {
  const session = getActiveSession();

  if (!session) {
    const next = getNextLineupRow(null);
    return {
      currentArtist: '',
      currentSong: '',
      currentOrder: null,
      currentLineupId: null,
      hasActivePerformance: false,
      isOpenForVoting: false,
      isPaused: false,
      allVotesCompleted,
      nextLineup: next
        ? {
            lineupId: next.id,
            artistName: next.artist_name,
            songTitle: next.song_title,
            performanceOrder: next.performance_order
          }
        : null,
      stats: {
        total: { count: 0, average: 0 },
        byRole: { judge: { count: 0, average: 0 }, public: { count: 0, average: 0 } }
      }
    };
  }

  const next = getNextLineupRow(session.performance_order);

  return {
    currentArtist: session.artist_name,
    currentSong: session.song_title || '',
    currentOrder: session.performance_order,
    currentLineupId: session.lineup_id,
    hasActivePerformance: true,
    isOpenForVoting: Boolean(session.is_open),
    isPaused: !Boolean(session.is_open),
    allVotesCompleted,
    nextLineup: next
      ? {
          lineupId: next.id,
          artistName: next.artist_name,
          songTitle: next.song_title,
          performanceOrder: next.performance_order
        }
      : null,
    stats: statsByLineupId(session.lineup_id)
  };
}

function roundScore(value) {
  return Number(Number(value || 0).toFixed(2));
}

function normalizeWeights(judgeWeight, publicWeight) {
  const safeJudge = Number.isFinite(judgeWeight) && judgeWeight >= 0 ? judgeWeight : 50;
  const safePublic = Number.isFinite(publicWeight) && publicWeight >= 0 ? publicWeight : 50;
  const total = safeJudge + safePublic;

  if (total <= 0) {
    return {
      judgePercent: 50,
      publicPercent: 50,
      judgeFactor: 0.5,
      publicFactor: 0.5
    };
  }

  return {
    judgePercent: roundScore((safeJudge / total) * 100),
    publicPercent: roundScore((safePublic / total) * 100),
    judgeFactor: safeJudge / total,
    publicFactor: safePublic / total
  };
}

function sortRankingRows(rows) {
  return rows
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (right.totalAverage !== left.totalAverage) {
        return right.totalAverage - left.totalAverage;
      }

      return left.performanceOrder - right.performanceOrder;
    })
    .map((row, index) => ({
      ...row,
      rank: index + 1
    }));
}

function buildRankings(summary, judgeWeight, publicWeight) {
  const weights = normalizeWeights(judgeWeight, publicWeight);

  const judge = sortRankingRows(
    summary.map((item) => ({
      lineupId: item.lineupId,
      artistName: item.artistName,
      songTitle: item.songTitle,
      performanceOrder: item.performanceOrder,
      judgeVotes: item.judgeVotes,
      publicVotes: item.publicVotes,
      totalVotes: item.totalVotes,
      judgeAverage: item.judgeAverage,
      publicAverage: item.publicAverage,
      totalAverage: item.totalAverage,
      score: roundScore(item.judgeAverage)
    }))
  );

  const publicRanking = sortRankingRows(
    summary.map((item) => ({
      lineupId: item.lineupId,
      artistName: item.artistName,
      songTitle: item.songTitle,
      performanceOrder: item.performanceOrder,
      judgeVotes: item.judgeVotes,
      publicVotes: item.publicVotes,
      totalVotes: item.totalVotes,
      judgeAverage: item.judgeAverage,
      publicAverage: item.publicAverage,
      totalAverage: item.totalAverage,
      score: roundScore(item.publicAverage)
    }))
  );

  const weighted = sortRankingRows(
    summary.map((item) => ({
      lineupId: item.lineupId,
      artistName: item.artistName,
      songTitle: item.songTitle,
      performanceOrder: item.performanceOrder,
      judgeVotes: item.judgeVotes,
      publicVotes: item.publicVotes,
      totalVotes: item.totalVotes,
      judgeAverage: item.judgeAverage,
      publicAverage: item.publicAverage,
      totalAverage: item.totalAverage,
      score: roundScore(
        item.judgeAverage * weights.judgeFactor + item.publicAverage * weights.publicFactor
      )
    }))
  );

  return {
    weights: {
      judge: weights.judgePercent,
      public: weights.publicPercent
    },
    judge,
    public: publicRanking,
    weighted
  };
}

function emitState(eventName) {
  const payload = buildStatePayload();
  io.emit('state:updated', payload);
  if (eventName) {
    io.emit(eventName, payload);
  }
  return payload;
}

function closeAnyActiveSession() {
  db.prepare(
    `
      UPDATE sessions
      SET is_open = 0,
          ended_at = datetime('now')
      WHERE ended_at IS NULL
    `
  ).run();
}

function upsertVote({ lineupId, role, voterName, score }) {
  const existing = db
    .prepare(
      `
      SELECT id
      FROM votes
      WHERE lineup_id = ? AND role = ? AND lower(voter_name) = lower(?)
    `
    )
    .get(lineupId, role, voterName);

  if (existing) {
    db.prepare(
      `
      UPDATE votes
      SET score = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `
    ).run(score, existing.id);
    return;
  }

  db.prepare(
    `
    INSERT INTO votes (lineup_id, role, voter_name, score)
    VALUES (?, ?, ?, ?)
  `
  ).run(lineupId, role, voterName, score);
}

function voteExists({ lineupId, role, voterName }) {
  const existing = db
    .prepare(
      `
      SELECT id
      FROM votes
      WHERE lineup_id = ? AND role = ? AND lower(voter_name) = lower(?)
      LIMIT 1
    `
    )
    .get(lineupId, role, voterName);

  return Boolean(existing);
}

function startPerformanceByLineupId(lineupId) {
  allVotesCompleted = false;

  const lineupRow = db
    .prepare(
      `
      SELECT id, artist_name, song_title, performance_order
      FROM lineup
      WHERE id = ?
      LIMIT 1
    `
    )
    .get(lineupId);

  if (!lineupRow) {
    return null;
  }

  closeAnyActiveSession();
  db.prepare('INSERT INTO sessions (lineup_id, is_open) VALUES (?, 1)').run(lineupId);

  return emitState('artist:changed');
}

app.get('/api/state', (_req, res) => {
  res.json(buildStatePayload());
});

app.get('/api/lineup', requireRoles(['gestione', 'admin']), (_req, res) => {
  res.json({ lineup: getLineup() });
});

app.post('/api/lineup', requireRoles(['gestione', 'admin']), (req, res) => {
  const artistName = String(req.body.artistName || '').trim();
  const songTitle = String(req.body.songTitle || '').trim();
  const performanceOrder = Number(req.body.performanceOrder);

  if (!artistName) {
    return res.status(400).json({ error: 'artistName obbligatorio' });
  }

  if (!Number.isInteger(performanceOrder) || performanceOrder < 1) {
    return res.status(400).json({ error: 'performanceOrder deve essere un intero >= 1' });
  }

  try {
    const result = db
      .prepare(
        `
        INSERT INTO lineup (artist_name, song_title, performance_order)
        VALUES (?, ?, ?)
      `
      )
      .run(artistName, songTitle, performanceOrder);

    io.emit('lineup:updated', { lineup: getLineup() });

    return res.status(201).json({
      message: 'Artista aggiunto in lineup',
      id: result.lastInsertRowid
    });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ordine gia occupato' });
    }

    return res.status(500).json({ error: 'Errore database in inserimento lineup' });
  }
});

app.post('/api/lineup/autogenerate', requireRoles(['admin']), (_req, res) => {
  const nextOrderRow = db
    .prepare(
      `
      SELECT COALESCE(MAX(performance_order), 0) AS maxOrder
      FROM lineup
    `
    )
    .get();

  const startOrder = Number(nextOrderRow.maxOrder || 0) + 1;

  const insertMany = db.transaction((fromOrder) => {
    const insert = db.prepare(
      `
      INSERT INTO lineup (artist_name, song_title, performance_order)
      VALUES (?, ?, ?)
    `
    );

    for (let index = 0; index < 10; index += 1) {
      const order = fromOrder + index;
      insert.run(`Artista Auto ${order}`, `Esibizione Auto ${order}`, order);
    }
  });

  try {
    insertMany(startOrder);
    io.emit('lineup:updated', { lineup: getLineup() });
    emitState();

    return res.status(201).json({
      message: 'Generate 10 esibizioni automatiche',
      inserted: 10,
      startOrder
    });
  } catch (_error) {
    return res.status(500).json({ error: 'Errore durante la generazione automatica lineup' });
  }
});

app.put('/api/lineup/:id', requireRoles(['gestione', 'admin']), (req, res) => {
  const lineupId = Number(req.params.id);
  const artistName = String(req.body.artistName || '').trim();
  const songTitle = String(req.body.songTitle || '').trim();
  const performanceOrder = Number(req.body.performanceOrder);

  if (!Number.isInteger(lineupId) || lineupId < 1) {
    return res.status(400).json({ error: 'lineupId non valido' });
  }

  if (!artistName) {
    return res.status(400).json({ error: 'artistName obbligatorio' });
  }

  if (!Number.isInteger(performanceOrder) || performanceOrder < 1) {
    return res.status(400).json({ error: 'performanceOrder deve essere un intero >= 1' });
  }

  try {
    const result = db
      .prepare(
        `
        UPDATE lineup
        SET artist_name = ?,
            song_title = ?,
            performance_order = ?
        WHERE id = ?
      `
      )
      .run(artistName, songTitle, performanceOrder, lineupId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Elemento lineup non trovato' });
    }

    io.emit('lineup:updated', { lineup: getLineup() });
    emitState();

    return res.status(200).json({ message: 'Elemento lineup aggiornato' });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ordine gia occupato' });
    }

    return res.status(500).json({ error: 'Errore database in aggiornamento lineup' });
  }
});

app.delete('/api/lineup/:id', requireRoles(['gestione', 'admin']), (req, res) => {
  const lineupId = Number(req.params.id);

  if (!Number.isInteger(lineupId) || lineupId < 1) {
    return res.status(400).json({ error: 'lineupId non valido' });
  }

  const active = getActiveSession();
  if (active && active.lineup_id === lineupId) {
    return res.status(409).json({ error: 'Impossibile eliminare artista in esibizione attiva' });
  }

  try {
    const result = db.prepare('DELETE FROM lineup WHERE id = ?').run(lineupId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Elemento lineup non trovato' });
    }

    io.emit('lineup:updated', { lineup: getLineup() });
    emitState();

    return res.status(200).json({ message: 'Elemento lineup eliminato' });
  } catch (_error) {
    return res.status(409).json({
      error: 'Elemento non eliminabile: esistono sessioni o voti collegati'
    });
  }
});

app.post('/api/artist', requireRoles(['admin']), (req, res) => {
  const artistName = String(req.body.artistName || '').trim();

  if (!artistName) {
    return res.status(400).json({ error: 'artistName obbligatorio' });
  }

  const lineupRow = db
    .prepare(
      `
      SELECT id
      FROM lineup
      WHERE lower(artist_name) = lower(?)
      ORDER BY performance_order ASC
      LIMIT 1
    `
    )
    .get(artistName);

  if (!lineupRow) {
    return res.status(404).json({ error: 'Artista non presente in lineup' });
  }

  const payload = startPerformanceByLineupId(lineupRow.id);
  return res.status(200).json({ message: 'Esibizione avviata', state: payload });
});

app.post('/api/lineup/activate', requireRoles(['gestione', 'admin']), (req, res) => {
  const lineupId = Number(req.body.lineupId);

  if (!Number.isInteger(lineupId) || lineupId < 1) {
    return res.status(400).json({ error: 'lineupId non valido' });
  }

  const payload = startPerformanceByLineupId(lineupId);
  if (!payload) {
    return res.status(404).json({ error: 'lineupId non trovato' });
  }

  return res.status(200).json({ message: 'Esibizione attivata', state: payload });
});

app.post('/api/performance/start', requireRoles(['admin']), (req, res) => {
  const lineupId = Number(req.body.lineupId);

  if (!Number.isInteger(lineupId) || lineupId < 1) {
    return res.status(400).json({ error: 'lineupId non valido' });
  }

  const payload = startPerformanceByLineupId(lineupId);
  if (!payload) {
    return res.status(404).json({ error: 'lineupId non trovato' });
  }

  return res.status(200).json({ message: 'Esibizione avviata', state: payload });
});

app.post('/api/performance/pause', requireRoles(['gestione', 'admin']), (_req, res) => {
  const active = getActiveSession();

  if (!active) {
    return res.status(400).json({ error: 'Nessuna esibizione attiva' });
  }

  if (!active.is_open) {
    return res.status(400).json({ error: 'Votazione gia in pausa' });
  }

  db.prepare('UPDATE sessions SET is_open = 0 WHERE id = ?').run(active.session_id);
  const payload = emitState('voting:paused');

  return res.status(200).json({ message: 'Votazione in pausa', state: payload });
});

app.post('/api/performance/resume', requireRoles(['gestione', 'admin']), (_req, res) => {
  allVotesCompleted = false;
  const active = getActiveSession();

  if (!active) {
    return res.status(400).json({ error: 'Nessuna esibizione attiva' });
  }

  if (active.is_open) {
    return res.status(400).json({ error: 'Votazione gia aperta' });
  }

  db.prepare('UPDATE sessions SET is_open = 1 WHERE id = ?').run(active.session_id);
  const payload = emitState('voting:resumed');

  return res.status(200).json({ message: 'Votazione riaperta', state: payload });
});

app.post('/api/performance/terminate', requireRoles(['admin']), (_req, res) => {
  const active = getActiveSession();

  if (!active) {
    return res.status(400).json({ error: 'Nessuna esibizione attiva' });
  }

  db.prepare(
    `
    UPDATE sessions
    SET is_open = 0,
        ended_at = datetime('now')
    WHERE id = ?
  `
  ).run(active.session_id);

  const payload = emitState('performance:terminated');
  return res.status(200).json({ message: 'Esibizione terminata', state: payload });
});

app.post('/api/performance/next', requireRoles(['gestione', 'admin']), (_req, res) => {
  allVotesCompleted = false;
  const active = getActiveSession();
  const currentOrder = active ? active.performance_order : null;

  if (active) {
    db.prepare(
      `
      UPDATE sessions
      SET is_open = 0,
          ended_at = datetime('now')
      WHERE id = ?
    `
    ).run(active.session_id);
  }

  const next = getNextLineupRow(currentOrder);
  if (!next) {
    const payload = emitState('lineup:finished');
    return res.status(404).json({ error: 'Nessun prossimo artista disponibile', state: payload });
  }

  db.prepare('INSERT INTO sessions (lineup_id, is_open) VALUES (?, 1)').run(next.id);

  const payload = emitState('artist:changed');
  return res.status(200).json({ message: 'Passato al prossimo artista', state: payload });
});

app.post('/api/close-voting', requireRoles(['gestione', 'admin']), (_req, res) => {
  const active = getActiveSession();

  if (!active) {
    return res.status(400).json({ error: 'Nessuna esibizione attiva' });
  }

  db.prepare(
    `
    UPDATE sessions
    SET is_open = 0,
        ended_at = datetime('now')
    WHERE id = ?
  `
  ).run(active.session_id);

  const payload = emitState('voting:closed');
  return res.status(200).json({ message: 'Votazione chiusa', state: payload });
});

app.get('/api/public/vote-status', (req, res) => {
  const active = getActiveSession();
  const voterId = String(req.query.deviceId || '').trim() || null;

  if (!active || allVotesCompleted) {
    return res.status(200).json({
      hasIdentifier: Boolean(voterId),
      hasVoted: false,
      currentLineupId: active ? active.lineup_id : null,
      isOpenForVoting: false
    });
  }

  const hasVoted = voterId
    ? voteExists({ lineupId: active.lineup_id, role: 'public', voterName: voterId })
    : false;

  return res.status(200).json({
    hasIdentifier: Boolean(voterId),
    hasVoted,
    currentLineupId: active.lineup_id,
    isOpenForVoting: Boolean(active.is_open)
  });
});

app.get('/api/runoff/state', (_req, res) => {
  res.status(200).json(buildRunoffState());
});

app.get('/api/runoff/vote-status', (req, res) => {
  const session = getActiveRunoffSession();
  const role = String(req.query.role || '').trim();
  const voterName = String(req.query.voterName || '').trim();
  const accessRole = getAccessRole(req);

  if (!session) {
    return res.status(200).json({ hasActiveRunoff: false, hasVoted: false, isOpenForVoting: false });
  }

  if (role !== 'judge' && role !== 'public') {
    return res.status(400).json({ error: 'role non valido' });
  }

  if (role === 'judge' && accessRole !== 'regia' && accessRole !== 'admin') {
    return res.status(401).json({ error: 'Accesso riservato a regia o admin per stato voto giudice' });
  }

  const hasVoted = voterName
    ? runoffVoteExists({ sessionId: session.id, role, voterName })
    : false;

  return res.status(200).json({
    hasActiveRunoff: true,
    hasVoted,
    isOpenForVoting: Boolean(session.is_open),
    sessionId: session.id
  });
});

app.post('/api/runoff/start', requireRoles(['gestione', 'admin']), (req, res) => {
  const firstLineupId = Number(req.body.firstLineupId);
  const secondLineupId = Number(req.body.secondLineupId);

  if (!Number.isInteger(firstLineupId) || !Number.isInteger(secondLineupId)) {
    return res.status(400).json({ error: 'Seleziona due artisti validi' });
  }

  if (firstLineupId === secondLineupId) {
    return res.status(400).json({ error: 'Gli artisti devono essere diversi' });
  }

  const lineupRows = db
    .prepare(
      `
      SELECT id
      FROM lineup
      WHERE id IN (?, ?)
    `
    )
    .all(firstLineupId, secondLineupId);

  if (lineupRows.length !== 2) {
    return res.status(404).json({ error: 'Artista non trovato in lineup' });
  }

  closeActiveRunoffSession();
  db.prepare(
    `
    INSERT INTO runoff_sessions (first_lineup_id, second_lineup_id, is_open)
    VALUES (?, ?, 1)
  `
  ).run(firstLineupId, secondLineupId);

  const state = emitRunoffState('runoff:started');
  return res.status(200).json({ message: 'Ballottaggio avviato', state });
});

app.post('/api/runoff/close', requireRoles(['gestione', 'admin']), (_req, res) => {
  const session = getActiveRunoffSession();
  if (!session) {
    return res.status(400).json({ error: 'Nessun ballottaggio attivo' });
  }

  db.prepare(
    `
    UPDATE runoff_sessions
    SET is_open = 0,
        closed_at = datetime('now')
    WHERE id = ?
  `
  ).run(session.id);

  const state = emitRunoffState('runoff:closed');
  return res.status(200).json({ message: 'Ballottaggio chiuso', state });
});

app.post('/api/runoff/vote', (req, res) => {
  const session = getActiveRunoffSession();
  const role = String(req.body.role || '').trim();
  const voterName = String(req.body.voterName || '').trim();
  const selectedLineupId = Number(req.body.selectedLineupId);
  const accessRole = getAccessRole(req);

  if (!session || !session.is_open) {
    return res.status(400).json({ error: 'Ballottaggio non attivo o chiuso' });
  }

  if (role !== 'judge' && role !== 'public') {
    return res.status(400).json({ error: 'role non valido' });
  }

  if (role === 'judge' && accessRole !== 'regia' && accessRole !== 'admin') {
    return res.status(401).json({ error: 'Accesso riservato a regia o admin per voto giudice' });
  }

  if (!voterName) {
    return res.status(400).json({ error: 'voterName obbligatorio' });
  }

  if (!Number.isInteger(selectedLineupId)) {
    return res.status(400).json({ error: 'selectedLineupId non valido' });
  }

  if (selectedLineupId !== session.first_lineup_id && selectedLineupId !== session.second_lineup_id) {
    return res.status(400).json({ error: 'Artista non valido per questo ballottaggio' });
  }

  if (runoffVoteExists({ sessionId: session.id, role, voterName })) {
    return res.status(409).json({ error: 'Hai gia votato in questo ballottaggio' });
  }

  db.prepare(
    `
    INSERT INTO runoff_votes (runoff_session_id, role, voter_name, selected_lineup_id)
    VALUES (?, ?, ?, ?)
  `
  ).run(session.id, role, voterName, selectedLineupId);

  const state = emitRunoffState('runoff:vote-updated');
  return res.status(200).json({ message: 'Voto ballottaggio registrato', state });
});

app.post('/api/vote', (req, res) => {
  const role = String(req.body.role || '').trim();
  let voterName = String(req.body.voterName || req.body.judgeName || '').trim();
  const score = Number(req.body.score);
  const accessRole = getAccessRole(req);

  if (allVotesCompleted) {
    return res.status(409).json({ error: 'Votazioni completate: non e piu possibile votare' });
  }

  const active = getActiveSession();
  if (!active || !active.is_open) {
    return res.status(400).json({ error: 'Nessuna esibizione attiva o votazione in pausa' });
  }

  if (role !== 'judge' && role !== 'public') {
    return res.status(403).json({ error: 'Ruolo non autorizzato al voto' });
  }

  if (role === 'judge' && accessRole !== 'regia' && accessRole !== 'admin') {
    return res.status(401).json({ error: 'Accesso riservato a regia o admin per voto giudice' });
  }

  if (role === 'public' && !voterName) {
    return res.status(400).json({ error: 'deviceId pubblico obbligatorio' });
  }

  if (role === 'judge' && !voterName) {
    return res.status(400).json({ error: 'voterName obbligatorio' });
  }

  if (!Number.isInteger(score) || score < 1 || score > 10) {
    return res.status(400).json({ error: 'Il punteggio deve essere tra 1 e 10' });
  }

  if (voteExists({ lineupId: active.lineup_id, role, voterName })) {
    return res.status(409).json({ error: 'Hai gia inviato il voto per questa esibizione' });
  }

  upsertVote({ lineupId: active.lineup_id, role, voterName, score });

  const payload = emitState('vote:updated');
  return res.status(200).json({ message: 'Voto registrato', state: payload });
});

app.post('/api/admin/clear-votes', requireRoles(['admin']), (_req, res) => {
  allVotesCompleted = false;
  db.prepare('DELETE FROM votes').run();
  const payload = emitState('votes:cleared');
  return res.status(200).json({ message: 'Dati votazioni puliti', state: payload });
});

app.post('/api/voting/complete', requireRoles(['gestione', 'admin']), (_req, res) => {
  allVotesCompleted = true;
  const payload = emitState('voting:completed');
  return res.status(200).json({ message: 'Tutte le votazioni sono state effettuate', state: payload });
});

app.get('/api/admin/export-lineup', requireRoles(['admin']), (_req, res) => {
  const lineup = getLineup();
  const filename = `lineup-${new Date().toISOString().split('T')[0]}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(lineup);
});

app.post('/api/admin/import-lineup', requireRoles(['admin']), (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) {
    return res.status(400).json({ error: 'Array di lineup atteso' });
  }

  const importLineup = db.transaction(() => {
    db.prepare('DELETE FROM lineup').run();
    const insert = db.prepare(
      `
      INSERT INTO lineup (id, artist_name, song_title, performance_order, created_at)
      VALUES (?, ?, ?, ?, ?)
    `
    );

    for (const item of data) {
      insert.run(
        item.id,
        item.artist_name,
        item.song_title || null,
        item.performance_order,
        item.created_at || new Date().toISOString()
      );
    }
  });

  try {
    importLineup();
    db.exec(`UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM lineup) WHERE name = 'lineup'`);
    io.emit('lineup:updated', { lineup: getLineup() });
    return res.status(200).json({ message: 'Lineup importata con successo', count: data.length });
  } catch (_error) {
    return res.status(500).json({ error: 'Errore durante l\'importazione lineup' });
  }
});

app.get('/api/admin/export-votes', requireRoles(['admin']), (_req, res) => {
  const votes = db
    .prepare(
      `
      SELECT id, lineup_id, role, voter_name, score, created_at, updated_at
      FROM votes
      ORDER BY lineup_id ASC, role ASC, voter_name ASC
    `
    )
    .all();

  const filename = `votes-${new Date().toISOString().split('T')[0]}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(votes);
});

app.post('/api/admin/import-votes', requireRoles(['admin']), (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) {
    return res.status(400).json({ error: 'Array di voti atteso' });
  }

  const importVotes = db.transaction(() => {
    db.prepare('DELETE FROM votes').run();
    const insert = db.prepare(
      `
      INSERT INTO votes (id, lineup_id, role, voter_name, score, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    );

    for (const item of data) {
      insert.run(
        item.id,
        item.lineup_id,
        item.role,
        item.voter_name,
        item.score,
        item.created_at || new Date().toISOString(),
        item.updated_at || null
      );
    }
  });

  try {
    importVotes();
    db.exec(`UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM votes) WHERE name = 'votes'`);
    allVotesCompleted = false;
    const payload = emitState('votes:updated');
    return res.status(200).json({ message: 'Voti importati con successo', count: data.length, state: payload });
  } catch (_error) {
    return res.status(500).json({ error: 'Errore durante l\'importazione voti' });
  }
});

app.get('/api/report', requireRoles(['gestione', 'admin']), (_req, res) => {
  const lineup = getLineup();
  const judgeWeight = Number(_req.query.judgeWeight);
  const publicWeight = Number(_req.query.publicWeight);

  const votes = db
    .prepare(
      `
      SELECT
        v.id,
        v.lineup_id,
        l.artist_name,
        l.song_title,
        l.performance_order,
        v.role,
        v.voter_name,
        v.score,
        v.created_at,
        v.updated_at
      FROM votes v
      JOIN lineup l ON l.id = v.lineup_id
      ORDER BY l.performance_order ASC, v.role ASC, v.voter_name ASC
    `
    )
    .all();

  const summary = lineup.map((item) => {
    const stats = statsByLineupId(item.id);
    return {
      lineupId: item.id,
      artistName: item.artist_name,
      songTitle: item.song_title,
      performanceOrder: item.performance_order,
      totalVotes: stats.total.count,
      totalAverage: stats.total.average,
      judgeVotes: stats.byRole.judge.count,
      judgeAverage: stats.byRole.judge.average,
      publicVotes: stats.byRole.public.count,
      publicAverage: stats.byRole.public.average
    };
  });

  const rankings = buildRankings(summary, judgeWeight, publicWeight);

  res.json({
    generatedAt: new Date().toISOString(),
    currentState: buildStatePayload(),
    lineup,
    summary,
    rankings,
    votes
  });
});

// Admin: backup manuale su Gist
app.post('/api/admin/backup-now', async (req, res) => {
  const role = getAccessRole(req);
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Accesso negato.' });
  }
  if (!GITHUB_BACKUP_TOKEN || !GITHUB_BACKUP_GIST_ID) {
    return res.status(503).json({ error: 'Backup Gist non configurato (manca GITHUB_BACKUP_TOKEN o GITHUB_BACKUP_GIST_ID).' });
  }
  const ok = await backupToGist();
  if (ok) {
    return res.json({ ok: true, message: 'Backup completato.' });
  }
  return res.status(500).json({ error: 'Backup fallito. Controlla i log.' });
});

// Admin: download a copy of the SQLite DB (safety net before a deploy)
app.get('/api/admin/db-backup', (req, res) => {
  const role = getAccessRole(req);
  if (role !== 'admin') {
    return res.status(403).json({ error: 'Accesso negato.' });
  }

  const configuredPath = String(process.env.DB_PATH || '').trim();
  const dbPath = configuredPath
    ? require('path').resolve(configuredPath)
    : require('path').join(__dirname, 'votation.db');

  if (!fs.existsSync(dbPath)) {
    return res.status(404).json({ error: 'File DB non trovato.' });
  }

  const filename = `votation-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(dbPath);
});

io.on('connection', (socket) => {
  socket.emit('state:init', buildStatePayload());
  socket.emit('runoff:state', buildRunoffState());
  socket.emit('lineup:updated', { lineup: getLineup() });
  socket.on('role:selected', () => {});
});

const PORT = process.env.PORT || 3000;
const httpServer_instance = httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server avviato su http://localhost:${PORT}`);
  console.log('Apri dal cellulare con http://IP_DEL_PC:3000');
});

// Graceful shutdown: on SIGTERM (used by Render during redeploy)
// close HTTP server first (stop accepting new connections), then close DB
process.on('SIGTERM', () => {
  console.log('SIGTERM ricevuto: backup + spegnimento graceful in corso...');
  backupToGist()
    .catch(() => {})
    .finally(() => {
      httpServer_instance.close(() => {
        console.log('Server HTTP chiuso.');
        try {
          db.close();
        } catch (_err) {
          // already closed
        }
        process.exit(0);
      });
      // Force exit after 10 seconds if close takes too long
      setTimeout(() => process.exit(0), 10000).unref();
    });
});
