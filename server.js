const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db, videoRow, UPLOADS_DIR, THUMBS_DIR } = require('./db');
const { hashPassword, verifyPassword, signToken, publicUser, currentUser, requireAuth, requireRole, sendJson, readJson } = require('./auth');
const { streamVideo, sendThumb, fileExists } = require('./media');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const GENRES = ['Wildlife', 'Scenic', 'Roads', 'Education', 'Other', 'Aerial'];
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function chained(...fns) {
  return (req, res, p) => {
    const run = (i) => {
      const fn = fns[i];
      if (!fn) return Promise.resolve();
      const last = i === fns.length - 1;
      const out = fn(req, res, last ? p : () => run(i + 1), p);
      return out && typeof out.then === 'function' ? out : Promise.resolve(out);
    };
    return run(0);
  };
}

function route(method, pattern, ...handlers) {
  const handler = handlers.length === 1 ? handlers[0] : chained(...handlers);
  return { method, pattern, regex: new RegExp('^' + pattern.replace(/:[^/]+/g, '([^/]+)') + '$'), handler };
}

function params(route, pathname) {
  const m = route.regex.exec(pathname);
  if (!m) return null;
  const names = (route.pattern.match(/:[^/]+/g) || []).map((n) => n.slice(1));
  const out = {};
  names.forEach((n, i) => { out[n] = decodeURIComponent(m[i + 1]); });
  return out;
}

const routes = [];

routes.push(route('GET', '/api/health', (req, res) => {
  sendJson(res, 200, { status: 'ok', service: 'vantage' });
}));

routes.push(route('GET', '/api/meta', (req, res) => {
  sendJson(res, 200, { genres: GENRES, ageRatings: ['G', 'PG', 'PG-13', 'R'] });
}));

routes.push(route('POST', '/api/auth/register', async (req, res) => {
  const body = await readJson(req);
  const username = String(body?.username || '').trim();
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!username || !email || password.length < 6) return sendJson(res, 400, { error: 'Username, valid email and 6+ char password required' });
  try {
    const info = db.prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)').run(username, email, hashPassword(password), 'consumer');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    sendJson(res, 201, { token: signToken({ userId: user.id, role: user.role }), user: publicUser(user) });
  } catch (e) {
    sendJson(res, 409, { error: e.message.includes('UNIQUE') ? 'Username or email already taken' : 'Could not create account' });
  }
}));

routes.push(route('POST', '/api/auth/login', async (req, res) => {
  const body = await readJson(req);
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) return sendJson(res, 401, { error: 'Invalid username or password' });
  sendJson(res, 200, { token: signToken({ userId: user.id, role: user.role }), user: publicUser(user) });
}));

function listVideos(qs) {
  const q = String(qs.get('q') || '').trim();
  const genre = String(qs.get('genre') || '').trim();
  const sort = String(qs.get('sort') || 'latest');
  const limit = Math.min(Number(qs.get('limit')) || 48, 100);
  const where = [];
  const args = [];
  if (q) {
    where.push('(v.title LIKE ? OR v.producer LIKE ? OR v.publisher LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like);
  }
  if (genre) { where.push('v.genre = ?'); args.push(genre); }
  const order = sort === 'popular' ? 'v.views DESC'
    : sort === 'rating' ? '(v.rating_count = 0), (v.rating_sum * 1.0 / v.rating_count) DESC'
    : 'v.created_at DESC, v.id DESC';
  const rows = db.prepare(`
    SELECT v.*, u.username AS uploader FROM videos v
    JOIN users u ON u.id = v.uploaded_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order} LIMIT ?`).all(...args, limit);
  return rows.map(videoRow);
}

routes.push(route('GET', '/api/videos', (req, res) => {
  const out = listVideos(new URL(req.url, 'http://x').searchParams);
  const payload = currentUser(req);
  if (payload) {
    const mine = new Map(db.prepare('SELECT video_id, stars FROM ratings WHERE user_id = ?').all(payload.userId).map((r) => [r.video_id, r.stars]));
    out.forEach((v) => { v.myRating = mine.get(v.id) || 0; });
  }
  sendJson(res, 200, out);
}));

routes.push(route('GET', '/api/videos/:id', (req, res, p) => {
  const v = db.prepare('SELECT v.*, u.username AS uploader FROM videos v JOIN users u ON u.id = v.uploaded_by WHERE v.id = ?').get(p.id);
  if (!v) return sendJson(res, 404, { error: 'Video not found' });
  const out = videoRow(v);
  const payload = currentUser(req);
  if (payload) {
    const rate = db.prepare('SELECT stars FROM ratings WHERE video_id = ? AND user_id = ?').get(v.id, payload.userId);
    out.myRating = rate ? rate.stars : 0;
    const prog = db.prepare('SELECT position FROM progress WHERE video_id = ? AND user_id = ?').get(v.id, payload.userId);
    out.progress = prog ? prog.position : 0;
  }
  sendJson(res, 200, out);
}));

routes.push(route('GET', '/api/videos/:id/related', (req, res, p) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(p.id);
  if (!v) return sendJson(res, 404, { error: 'Video not found' });
  const rows = db.prepare(`
    SELECT v.*, u.username AS uploader FROM videos v JOIN users u ON u.id = v.uploaded_by
    WHERE v.id != ? ORDER BY (v.genre = ?) DESC, v.views DESC LIMIT 4`).all(v.id, v.genre);
  sendJson(res, 200, rows.map(videoRow));
}));

routes.push(route('GET', '/api/videos/:id/stream', (req, res, p) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(p.id);
  const file = path.join(UPLOADS_DIR, v ? v.filename : '');
  if (!v || !fileExists(file)) return sendJson(res, 404, { error: 'Video file missing' });
  streamVideo(req, res, file);
}));

routes.push(route('GET', '/api/videos/:id/thumb', (req, res, p) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(p.id);
  if (!v) return sendThumb(req, res, null, Number(p.id));
  sendThumb(req, res, v, Number(p.id));
}));

routes.push(route('GET', '/api/videos/:id/comments', (req, res, p) => {
  const rows = db.prepare(`
    SELECT c.*, u.username FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.video_id = ? ORDER BY c.id DESC LIMIT 200`).all(p.id);
  sendJson(res, 200, rows.map((c) => ({ id: c.id, videoId: c.video_id, userId: c.user_id, username: c.username, body: c.body, createdAt: c.created_at })));
}));

routes.push(route('POST', '/api/videos/:id/comments', requireAuth, requireRole('consumer'), async (req, res, p) => {
  const v = db.prepare('SELECT id FROM videos WHERE id = ?').get(p.id);
  if (!v) return sendJson(res, 404, { error: 'Video not found' });
  const body = await readJson(req);
  const text = String(body?.body || '').trim().slice(0, 500);
  if (!text) return sendJson(res, 400, { error: 'Comment is empty' });
  const info = db.prepare('INSERT INTO comments (video_id, user_id, body) VALUES (?, ?, ?)').run(p.id, req.user.userId, text);
  db.prepare('UPDATE videos SET comment_count = comment_count + 1 WHERE id = ?').run(p.id);
  const c = db.prepare('SELECT c.*, u.username FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(info.lastInsertRowid);
  sendJson(res, 201, { id: c.id, videoId: c.video_id, userId: c.user_id, username: c.username, body: c.body, createdAt: c.created_at });
}));

routes.push(route('DELETE', '/api/comments/:id', requireAuth, (req, res, p) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(p.id);
  if (!c) return sendJson(res, 404, { error: 'Comment not found' });
  if (req.user.role !== 'admin' && c.user_id !== req.user.userId) return sendJson(res, 403, { error: 'Not your comment' });
  db.prepare('DELETE FROM comments WHERE id = ?').run(p.id);
  db.prepare('UPDATE videos SET comment_count = MAX(0, comment_count - 1) WHERE id = ?').run(c.video_id);
  sendJson(res, 200, { ok: true });
}));

routes.push(route('POST', '/api/videos/:id/rating', requireAuth, requireRole('consumer'), async (req, res, p) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(p.id);
  if (!v) return sendJson(res, 404, { error: 'Video not found' });
  const body = await readJson(req);
  const stars = Number(body?.stars);
  if (stars === 0) {
    const old = db.prepare('SELECT stars FROM ratings WHERE video_id = ? AND user_id = ?').get(p.id, req.user.userId);
    if (old) {
      db.prepare('DELETE FROM ratings WHERE video_id = ? AND user_id = ?').run(p.id, req.user.userId);
      db.prepare('UPDATE videos SET rating_count = MAX(0, rating_count - 1), rating_sum = MAX(0, rating_sum - ?) WHERE id = ?').run(old.stars, p.id);
    }
    const nv = db.prepare('SELECT * FROM videos WHERE id = ?').get(p.id);
    return sendJson(res, 200, { stars: 0, ratingCount: nv.rating_count, avgRating: nv.rating_count ? Math.round((nv.rating_sum / nv.rating_count) * 10) / 10 : 0 });
  }
  if (![1, 2, 3, 4, 5].includes(stars)) return sendJson(res, 400, { error: 'Stars must be 1-5' });
  const existing = db.prepare('SELECT stars FROM ratings WHERE video_id = ? AND user_id = ?').get(p.id, req.user.userId);
  db.prepare('INSERT INTO ratings (video_id, user_id, stars) VALUES (?, ?, ?) ON CONFLICT(video_id, user_id) DO UPDATE SET stars = excluded.stars').run(p.id, req.user.userId, stars);
  if (existing) {
    db.prepare('UPDATE videos SET rating_sum = rating_sum + ? WHERE id = ?').run(stars - existing.stars, p.id);
  } else {
    db.prepare('UPDATE videos SET rating_count = rating_count + 1, rating_sum = rating_sum + ? WHERE id = ?').run(stars, p.id);
  }
  const nv = db.prepare('SELECT * FROM videos WHERE id = ?').get(p.id);
  sendJson(res, 200, { stars, ratingCount: nv.rating_count, avgRating: nv.rating_count ? Math.round((nv.rating_sum / nv.rating_count) * 10) / 10 : 0 });
}));

routes.push(route('POST', '/api/videos/:id/view', (req, res, p) => {
  const info = db.prepare('UPDATE videos SET views = views + 1 WHERE id = ?').run(p.id);
  if (!info.changes) return sendJson(res, 404, { error: 'Video not found' });
  sendJson(res, 200, { ok: true });
}));

routes.push(route('GET', '/api/videos/:id/progress', requireAuth, requireRole('consumer'), (req, res, p) => {
  const row = db.prepare('SELECT position FROM progress WHERE video_id = ? AND user_id = ?').get(p.id, req.user.userId);
  sendJson(res, 200, { position: row ? row.position : 0 });
}));

routes.push(route('PUT', '/api/videos/:id/progress', requireAuth, requireRole('consumer'), async (req, res, p) => {
  const body = await readJson(req);
  const position = Math.max(0, Number(body?.position) || 0);
  db.prepare('INSERT INTO progress (user_id, video_id, position, updated_at) VALUES (?, ?, ?, datetime(\'now\')) ON CONFLICT(user_id, video_id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at').run(req.user.userId, p.id, Math.round(position));
  sendJson(res, 200, { ok: true });
}));

routes.push(route('GET', '/api/me/playlists', requireAuth, (req, res) => {
  const qs = new URL(req.url, 'http://x').searchParams;
  const videoId = Number(qs.get('videoId')) || 0;
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count,
      (SELECT pi.video_id FROM playlist_items pi WHERE pi.playlist_id = p.id ORDER BY pi.added_at DESC LIMIT 1) AS cover_video_id
    FROM playlists p WHERE p.user_id = ? ORDER BY p.created_at DESC`).all(req.user.userId);
  const has = videoId ? db.prepare('SELECT playlist_id FROM playlist_items WHERE video_id = ?').all(videoId).map((r) => r.playlist_id) : [];
  sendJson(res, 200, rows.map((r) => ({ id: r.id, name: r.name, itemCount: r.item_count, coverVideoId: r.cover_video_id, createdAt: r.created_at, containsVideo: videoId ? has.includes(r.id) : undefined })));
}));

routes.push(route('POST', '/api/me/playlists', requireAuth, async (req, res) => {
  const body = await readJson(req);
  const name = String(body?.name || '').trim().slice(0, 80);
  if (!name) return sendJson(res, 400, { error: 'Playlist name required' });
  const info = db.prepare('INSERT INTO playlists (user_id, name) VALUES (?, ?)').run(req.user.userId, name);
  sendJson(res, 201, { id: info.lastInsertRowid, name, itemCount: 0 });
}));

routes.push(route('DELETE', '/api/me/playlists/:id', requireAuth, (req, res, p) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.id);
  if (!pl) return sendJson(res, 404, { error: 'Playlist not found' });
  if (pl.user_id !== req.user.userId && req.user.role !== 'admin') return sendJson(res, 403, { error: 'Not your playlist' });
  db.prepare('DELETE FROM playlists WHERE id = ?').run(p.id);
  sendJson(res, 200, { ok: true });
}));

routes.push(route('GET', '/api/playlists/:id', (req, res, p) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.id);
  if (!pl) return sendJson(res, 404, { error: 'Playlist not found' });
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(pl.user_id);
  const items = db.prepare(`
    SELECT v.*, u.username AS uploader FROM playlist_items pi
    JOIN videos v ON v.id = pi.video_id JOIN users u ON u.id = v.uploaded_by
    WHERE pi.playlist_id = ? ORDER BY pi.added_at DESC`).all(p.id);
  sendJson(res, 200, { id: pl.id, name: pl.name, owner: owner ? owner.username : '?', items: items.map(videoRow) });
}));

routes.push(route('POST', '/api/playlists/:id/items', requireAuth, async (req, res, p) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.id);
  if (!pl) return sendJson(res, 404, { error: 'Playlist not found' });
  if (pl.user_id !== req.user.userId) return sendJson(res, 403, { error: 'Not your playlist' });
  const body = await readJson(req);
  const video = db.prepare('SELECT id FROM videos WHERE id = ?').get(Number(body?.videoId));
  if (!video) return sendJson(res, 404, { error: 'Video not found' });
  db.prepare('INSERT INTO playlist_items (playlist_id, video_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(p.id, video.id);
  sendJson(res, 201, { ok: true });
}));

routes.push(route('DELETE', '/api/playlists/:id/items/:videoId', requireAuth, (req, res, p) => {
  const pl = db.prepare('SELECT * FROM playlists WHERE id = ?').get(p.id);
  if (!pl) return sendJson(res, 404, { error: 'Playlist not found' });
  if (pl.user_id !== req.user.userId) return sendJson(res, 403, { error: 'Not your playlist' });
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND video_id = ?').run(p.id, p.videoId);
  sendJson(res, 200, { ok: true });
}));

routes.push(route('GET', '/api/me/videos', requireAuth, requireRole('creator', 'admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT v.*, u.username AS uploader FROM videos v JOIN users u ON u.id = v.uploaded_by
    WHERE v.uploaded_by = ? ORDER BY v.created_at DESC`).all(req.user.userId);
  sendJson(res, 200, rows.map(videoRow));
}));

routes.push(route('POST', '/api/videos', requireAuth, requireRole('creator', 'admin'), (req, res) => {
  const url = new URL(req.url, 'http://x');
  const title = String(url.searchParams.get('title') || '').trim().slice(0, 120);
  const publisher = String(url.searchParams.get('publisher') || '').trim().slice(0, 80);
  const producer = String(url.searchParams.get('producer') || '').trim().slice(0, 80);
  const genre = String(url.searchParams.get('genre') || 'Other').trim();
  const age = String(url.searchParams.get('age') || 'G').trim();
  const ext = String(url.searchParams.get('ext') || 'mp4').replace(/[^a-z0-9]/gi, '');
  if (!title) return sendJson(res, 400, { error: 'Title required' });
  if (!GENRES.includes(genre)) return sendJson(res, 400, { error: 'Unknown genre' });
  const filename = `u${req.user.userId}_${Date.now()}.${ext || 'mp4'}`;
  const file = path.join(UPLOADS_DIR, filename);
  const out = fs.createWriteStream(file);
  let received = 0;
  req.on('data', (c) => {
    received += c.length;
    if (received > MAX_UPLOAD) { out.destroy(); req.destroy(); sendJson(res, 413, { error: 'Upload too large' }); }
  });
  req.on('error', () => { out.destroy(); });
  out.on('error', () => {});
  req.pipe(out);
  out.on('finish', () => {
    const info = db.prepare('INSERT INTO videos (title, publisher, producer, genre, age_rating, filename, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(title, publisher || 'Vantage Studios', producer || req.user.username || 'Creator', genre, age, filename, req.user.userId);
    sendJson(res, 201, { id: info.lastInsertRowid, title });
  });
}));

routes.push(route('PATCH', '/api/videos/:id', requireAuth, async (req, res, p) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(p.id);
  if (!v) return sendJson(res, 404, { error: 'Video not found' });
  if (req.user.role !== 'admin' && v.uploaded_by !== req.user.userId) return sendJson(res, 403, { error: 'Not your video' });
  const body = await readJson(req);
  const title = String(body?.title ?? v.title).trim().slice(0, 120);
  const publisher = String(body?.publisher ?? v.publisher).trim().slice(0, 80);
  const producer = String(body?.producer ?? v.producer).trim().slice(0, 80);
  const genre = String(body?.genre ?? v.genre).trim();
  if (!title || !GENRES.includes(genre)) return sendJson(res, 400, { error: 'Invalid metadata' });
  db.prepare('UPDATE videos SET title = ?, publisher = ?, producer = ?, genre = ? WHERE id = ?').run(title, publisher, producer, genre, p.id);
  sendJson(res, 200, { ok: true });
}));

routes.push(route('DELETE', '/api/videos/:id', requireAuth, (req, res, p) => {
  const v = db.prepare('SELECT * FROM videos WHERE id = ?').get(p.id);
  if (!v) return sendJson(res, 404, { error: 'Video not found' });
  if (req.user.role !== 'admin' && v.uploaded_by !== req.user.userId) return sendJson(res, 403, { error: 'Not your video' });
  db.prepare('DELETE FROM videos WHERE id = ?').run(p.id);
  fs.rmSync(path.join(UPLOADS_DIR, v.filename), { force: true });
  fs.rmSync(path.join(THUMBS_DIR, v.filename.replace(/\.[^.]+$/, '') + '.jpg'), { force: true });
  sendJson(res, 200, { ok: true });
}));

routes.push(route('GET', '/api/admin/creators', requireAuth, requireRole('admin'), (req, res) => {
  const rows = db.prepare("SELECT id, username, email, created_at FROM users WHERE role = 'creator' ORDER BY id").all();
  sendJson(res, 200, rows.map((r) => ({ id: r.id, username: r.username, email: r.email, createdAt: r.created_at })));
}));

routes.push(route('POST', '/api/admin/creators', requireAuth, requireRole('admin'), async (req, res) => {
  const body = await readJson(req);
  const username = String(body?.username || '').trim();
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!username || !email || password.length < 6) return sendJson(res, 400, { error: 'Username, email and 6+ char password required' });
  try {
    const info = db.prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'creator')").run(username, email, hashPassword(password));
    sendJson(res, 201, { id: info.lastInsertRowid, username, email });
  } catch {
    sendJson(res, 409, { error: 'Username or email already taken' });
  }
}));

routes.push(route('DELETE', '/api/admin/creators/:id', requireAuth, requireRole('admin'), (req, res, p) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(p.id);
  if (!u) return sendJson(res, 404, { error: 'User not found' });
  if (u.role !== 'creator') return sendJson(res, 400, { error: 'Only creator accounts can be removed' });
  db.prepare('DELETE FROM users WHERE id = ?').run(p.id);
  sendJson(res, 200, { ok: true });
}));

routes.push(route('GET', '/api/admin/stats', requireAuth, requireRole('admin'), (req, res) => {
  const u = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  const v = db.prepare('SELECT COUNT(*) AS n FROM videos').get();
  const c = db.prepare('SELECT COUNT(*) AS n FROM comments').get();
  sendJson(res, 200, { users: u.n, videos: v.n, comments: c.n });
}));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  const method = req.method;

  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const p = params(r, pathname);
      if (!p) continue;
      try {
        await r.handler(req, res, p);
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
      }
      return;
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (pathname === '/favicon.ico') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0d1410"/><path d="M14 46 L28 18 L36 36 L42 26 L52 46 Z" fill="#c9f73c"/></svg>`;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    res.end(svg);
    return;
  }

  if (pathname.startsWith('/static/')) {
    const rel = pathname.slice('/static/'.length).replace(/\.\./g, '');
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  const index = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(index)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('public/index.html missing');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(index).pipe(res);
});

server.listen(PORT, () => {
  console.log(`vantage listening on :${PORT}`);
});