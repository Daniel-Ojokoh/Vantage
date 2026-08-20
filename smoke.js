const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 8081;
const BASE = `http://127.0.0.1:${PORT}`;
const VANTAGE_DIR = __dirname;
const ENV = { ...process.env, PORT: String(PORT), VANTAGE_DATA: path.join(VANTAGE_DIR, '.smoke-data') };

const passed = [];
const failed = [];
function check(name, ok, extra = '') {
  (ok ? passed : failed).push(name + (extra ? ' :: ' + extra : ''));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}

async function api(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(ENV.VANTAGE_DATA, { recursive: true, force: true });
  const child = spawn(process.execPath, ['server.js'], { cwd: VANTAGE_DIR, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[server-err] ' + d));
  for (let i = 0; i < 40; i++) {
    try { await fetch(BASE + '/api/health'); break; } catch { await sleep(250); }
  }

  try {
    let r = await api('GET', '/api/health');
    check('health', r.status === 200 && r.data.status === 'ok');

    r = await api('GET', '/api/meta');
    check('meta genres', r.status === 200 && r.data.genres.includes('Wildlife') && r.data.ageRatings.includes('PG-13'));

    const seed = spawn(process.execPath, ['seed.js'], { cwd: VANTAGE_DIR, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
    let seedErr = '';
    seed.stderr.on('data', (d) => { if (!String(d).includes('ExperimentalWarning')) seedErr += d; });
    await new Promise((res) => seed.on('exit', res));
    check('seed exit clean', seedErr === '', seedErr.slice(0, 120));
    await sleep(100);

    r = await api('GET', '/api/videos');
    check('videos list 9', r.status === 200 && r.data.length === 9, `got ${r.data && r.data.length}`);
    const vids = r.data;

    r = await api('GET', '/api/videos?genre=Scenic&sort=rating');
    check('videos filter+sort', r.status === 200 && r.data.every((v) => v.genre === 'Scenic') && r.data.length > 0);

    r = await api('GET', '/api/videos?q=nobody');
    check('search no match', r.status === 200 && r.data.length === 0);

    r = await api('GET', '/api/videos/999');
    check('video 404', r.status === 404);

    r = await api('GET', `/api/videos/${vids[0].id}`);
    check('video detail', r.status === 200 && r.data.title === vids[0].title && r.data.uploader);

    r = await api('GET', `/api/videos/${vids[0].id}/related`);
    check('related', r.status === 200 && r.data.length >= 3 && r.data.every((v) => v.id !== vids[0].id));

    r = await api('GET', `/api/videos/${vids[0].id}/stream`, {});
    const streamBuf = Buffer.from(await (await fetch(BASE + `/api/videos/${vids[0].id}/stream`, { headers: { Range: 'bytes=0-99' } })).arrayBuffer());
    check('stream range', streamBuf.length === 100);

    const thumbRes = await fetch(BASE + `/api/videos/${vids[0].id}/thumb`);
    const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
    check('thumb 200', thumbRes.status === 200 && thumbRes.headers.get('content-type').includes('image/jpeg') && thumbBuf.length > 1000, `len ${thumbBuf.length}`);
    const phRes = await fetch(BASE + '/api/videos/999/thumb');
    check('placeholder thumb 200', phRes.status === 200, `len ${(await phRes.arrayBuffer()).byteLength}`);

    r = await api('GET', `/api/videos/${vids[0].id}/comments`);
    check('comments list', r.status === 200 && r.data.length === 3, `got ${r.data.length}`);

    r = await api('POST', '/api/auth/login', { body: { username: 'viewer1', password: 'viewer123' } });
    check('login consumer', r.status === 200 && r.data.user.role === 'consumer');
    const qt = r.data.token;

    r = await api('POST', '/api/auth/login', { body: { username: 'viewer1', password: 'wrong' } });
    check('login bad pw 401', r.status === 401);

    r = await api('GET', `/api/videos/${vids[0].id}`, { token: qt });
    check('detail w/ myRating', r.status === 200 && r.data.myRating === 0);

    r = await api('POST', `/api/videos/${vids[0].id}/comments`, { token: qt, body: { body: 'smoke test comment' } });
    check('post comment', r.status === 201 && r.data.username === 'viewer1');
    r = await api('GET', `/api/videos/${vids[0].id}/comments`, { token: qt });
    check('comment count grew', r.status === 200 && r.data.length === 4);

    r = await api('POST', `/api/videos/${vids[0].id}/rating`, { token: qt, body: { stars: 5 } });
    check('rate 5', r.status === 200 && r.data.stars === 5 && r.data.avgRating > 0);
    r = await api('GET', `/api/videos/${vids[0].id}`, { token: qt });
    check('myRating persisted', r.status === 200 && r.data.myRating === 5);
    r = await api('POST', `/api/videos/${vids[0].id}/rating`, { token: qt, body: { stars: 0 } });
    check('unlike (0)', r.status === 200 && r.data.stars === 0);
    r = await api('GET', `/api/videos/${vids[0].id}`, { token: qt });
    check('myRating cleared', r.status === 200 && r.data.myRating === 0);

    r = await api('PUT', `/api/videos/${vids[0].id}/progress`, { token: qt, body: { position: 42 } });
    check('save progress', r.status === 200);
    r = await api('GET', `/api/videos/${vids[0].id}`, { token: qt });
    check('progress persisted', r.status === 200 && r.data.progress === 42);

    r = await api('POST', '/api/me/playlists', { token: qt, body: { name: 'Smoke List' } });
    check('create playlist', r.status === 201);
    const plId = r.data.id;
    r = await api('POST', `/api/playlists/${plId}/items`, { token: qt, body: { videoId: vids[1].id } });
    check('add item', r.status === 201);
    r = await api('GET', '/api/me/playlists?videoId=' + vids[1].id, { token: qt });
    check('playlist membership flag', r.status === 200 && r.data[0].containsVideo === true);
    r = await api('GET', `/api/playlists/${plId}`, { token: qt });
    check('playlist detail', r.status === 200 && r.data.items.length === 1 && r.data.owner === 'viewer1');
    r = await api('DELETE', `/api/playlists/${plId}/items/${vids[1].id}`, { token: qt });
    check('remove item', r.status === 200);

    r = await api('POST', '/api/videos/999/rating', { token: qt, body: { stars: 5 } });
    check('rating 404 video', r.status === 404);

    r = await api('POST', '/api/auth/register', { body: { username: 'newfan', email: 'newfan@example.com', password: 'fanfan1' } });
    check('register consumer', r.status === 201 && r.data.user.role === 'consumer');
    const nt = r.data.token;
    r = await api('POST', '/api/auth/register', { body: { username: 'newfan', email: 'other@example.com', password: 'fanfan1' } });
    check('register dup 409', r.status === 409);

    r = await api('GET', '/api/me/videos', { token: qt });
    check('consumer blocked from mine', r.status === 403);

    r = await api('POST', '/api/auth/login', { body: { username: 'creator1', password: 'creator123' } });
    check('login creator', r.status === 200 && r.data.user.role === 'creator');
    const lt = r.data.token;

    r = await api('GET', '/api/me/videos', { token: lt });
    check('creator videos', r.status === 200 && r.data.length >= 3, `got ${r.data.length}`);
    const my = r.data[0];

    r = await api('PATCH', `/api/videos/${my.id}`, { token: lt, body: { title: 'Smoke Retitled', publisher: 'SmokePub', producer: 'SmokeProd', genre: 'Other' } });
    check('patch video', r.status === 200);
    r = await api('GET', `/api/videos/${my.id}`, { token: lt });
    check('patch persisted', r.status === 200 && r.data.title === 'Smoke Retitled');

    r = await api('DELETE', `/api/videos/${my.id}`, { token: lt });
    check('delete video', r.status === 200);
    r = await api('GET', `/api/videos/${my.id}`);
    check('video gone', r.status === 404);

    r = await api('GET', '/api/admin/creators', { token: qt });
    check('admin gate', r.status === 403);

    r = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    check('login admin', r.status === 200 && r.data.user.role === 'admin');
    const at = r.data.token;
    r = await api('GET', '/api/admin/stats', { token: at });
    check('admin stats', r.status === 200 && r.data.users >= 3, `users ${r.data && r.data.users}`);
    r = await api('GET', '/api/admin/creators', { token: at });
    check('admin creators', r.status === 200 && r.data.length >= 1);
    r = await api('POST', '/api/admin/creators', { token: at, body: { username: 'smoke_creator', email: 'smoke@example.com', password: 'smokeme1' } });
    check('provision creator', r.status === 201);
    const cid = r.data.id;
    r = await api('DELETE', `/api/admin/creators/${cid}`, { token: at });
    check('deprovision creator', r.status === 200);

    r = await api('POST', '/api/auth/login', { body: { username: 'smoke_creator', password: 'smokeme1' } });
    check('deprovisioned cannot login', r.status === 401);

    r = await api('POST', '/api/auth/login', { body: { username: 'viewer1', password: 'viewer123' } });
    check('login viewer1 consumer', r.status === 200);

    const idx = await fetch(BASE + '/');
    check('index served', idx.status === 200 && (await idx.text()).includes('VANTAGE'));
    const css = await fetch(BASE + '/static/styles.css');
    check('static css', css.status === 200 && (await css.text()).includes('--accent'));
    const js = await fetch(BASE + '/static/app.js');
    check('static js', js.status === 200 && (await js.text()).includes('renderFeed'));
    const fall = await fetch(BASE + '/some/spa/route');
    check('spa fallback', fall.status === 200 && (await fall.text()).includes('VANTAGE'));
  } catch (e) {
    check('smoke crash', false, e.message);
  } finally {
    child.kill();
  }

  console.log(`\n${passed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

main();
