const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

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

function requireRoles(allowedRoles) {
  return (req, res, next) => {
    const role = getAccessRole(req);
    if (!role || !allowedRoles.includes(role)) {
      denyAuth(res);
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

  const publicPages = new Set(['/', '/login.html', '/public.html']);
  const anyRolePages = new Set(['/index.html']);
  const gestionePages = new Set(['/director.html', '/report.html']);
  const regiaPages = new Set(['/judge.html']);
  const adminPages = new Set(['/performance.html', '/lineup.html']);

  if (publicPages.has(req.path)) {
    next();
    return;
  }

  if (anyRolePages.has(req.path)) {
    if (!role) {
      denyAuth(res);
      return;
    }
    next();
    return;
  }

  if (gestionePages.has(req.path)) {
    if (role !== 'gestione' && role !== 'admin') {
      denyAuth(res);
      return;
    }
    next();
    return;
  }

  if (regiaPages.has(req.path)) {
    if (role !== 'regia' && role !== 'admin') {
      denyAuth(res);
      return;
    }
    next();
    return;
  }

  if (adminPages.has(req.path)) {
    if (role !== 'admin') {
      denyAuth(res);
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

app.get('/api/lineup', requireRoles(['admin']), (_req, res) => {
  res.json({ lineup: getLineup() });
});

app.post('/api/lineup', requireRoles(['admin']), (req, res) => {
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

app.put('/api/lineup/:id', requireRoles(['admin']), (req, res) => {
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

app.delete('/api/lineup/:id', requireRoles(['admin']), (req, res) => {
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

app.post('/api/performance/pause', requireRoles(['admin']), (_req, res) => {
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

app.post('/api/performance/resume', requireRoles(['admin']), (_req, res) => {
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

app.post('/api/performance/next', requireRoles(['admin']), (_req, res) => {
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

  if (!active) {
    return res.status(200).json({
      hasIdentifier: Boolean(voterId),
      hasVoted: false,
      currentLineupId: null,
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

app.post('/api/vote', (req, res) => {
  const role = String(req.body.role || '').trim();
  let voterName = String(req.body.voterName || req.body.judgeName || '').trim();
  const score = Number(req.body.score);
  const accessRole = getAccessRole(req);

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
  db.prepare('DELETE FROM votes').run();
  const payload = emitState('votes:cleared');
  return res.status(200).json({ message: 'Dati votazioni puliti', state: payload });
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

io.on('connection', (socket) => {
  socket.emit('state:init', buildStatePayload());
  socket.emit('lineup:updated', { lineup: getLineup() });
  socket.on('role:selected', () => {});
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server avviato su http://localhost:${PORT}`);
  console.log('Apri dal cellulare con http://IP_DEL_PC:3000');
});
