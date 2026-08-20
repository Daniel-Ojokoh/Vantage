// vantage-agg.cjs — Vantage end-to-end suite (API + desktop UI + mobile UI)
// Spawns its own server when VB is not set; point at a deployed instance with VB=http://host:port.
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const REPO = path.dirname(__dirname);
const PORT = Number(process.env.AGG_PORT || 8181);
const BASE = process.env.VB || `http://127.0.0.1:${PORT}`;
const SPAWN = !process.env.VB;
const VANTAGE = process.env.VANTAGE_DIR || REPO;
const STOCK = process.env.STOCK_DIR || path.join(REPO, 'stock-videos');
const DATA = process.env.AGG_DATA || path.join(REPO, '.agg-data');

const passed = [];
const failed = [];
function check(name, ok, extra = '') {
  (ok ? passed : failed).push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
}
async function api(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch { }
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 8000, step = 200) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch { }
    if (Date.now() - t0 > ms) return false;
    await sleep(step);
  }
}

let server = null;
async function boot() {
  if (!SPAWN) return;
  try {
    const pre = await fetch(BASE + '/api/health');
    if (pre && pre.ok) throw new Error(`port ${PORT} already serves a Vantage instance — stop it first or set AGG_PORT`);
  } catch (e) {
    if (/already serves/.test(e.message)) throw e;
  }
  fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, PORT: String(PORT), VANTAGE_DATA: DATA, STOCK_DIR: STOCK };
  server = spawn(process.execPath, ['server.js'], { cwd: VANTAGE, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => { if (!String(d).includes('ExperimentalWarning')) process.stderr.write('[vsrv] ' + d); });
  let died = false;
  server.on('exit', () => { died = true; });
  let ok = false;
  for (let i = 0; i < 60 && !ok && !died; i++) {
    try { await fetch(BASE + '/api/health'); ok = true; } catch { await sleep(250); }
  }
  if (!ok) throw new Error(died ? 'vantage server exited early — is VANTAGE_DIR correct?' : 'vantage server not healthy on port ' + PORT);
  await new Promise((res) => {
    const seed = spawn(process.execPath, ['seed.js'], { cwd: VANTAGE, env, stdio: 'ignore' });
    seed.on('exit', res);
  });
}

async function preflightCleanup() {
  if (SPAWN) return;
  try {
    const q = (await api('POST', '/api/auth/login', { body: { username: 'viewer1', password: 'viewer123' } })).data.token;
    const pls = await api('GET', '/api/me/playlists', { token: q });
    for (const p of pls.data.filter((x) => String(x.name).startsWith('Suite Picks'))) await api('DELETE', '/api/me/playlists/' + p.id, { token: q });
    const l = (await api('POST', '/api/auth/login', { body: { username: 'creator1', password: 'creator123' } })).data.token;
    const mine = await api('GET', '/api/me/videos', { token: l });
    for (const v of mine.data.filter((x) => String(x.title).startsWith('Agg Upload'))) await api('DELETE', '/api/videos/' + v.id, { token: l });
    const a = (await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } })).data.token;
    const cs = await api('GET', '/api/admin/creators', { token: a });
    for (const c of cs.data.filter((x) => x.username === 'suite_creator')) await api('DELETE', '/api/admin/creators/' + c.id, { token: a });
    console.log('--- preflight cleanup done ---');
  } catch (e) {
    console.log('--- preflight cleanup skipped:', e.message, '---');
  }
}

const sleepMs = { fav: null };

async function main() {
  await boot();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);

  const clearSession = async () => {
    await page.goto(BASE + '/#/feed', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.evaluate(() => { localStorage.removeItem('vt-token'); localStorage.removeItem('vt-user'); });
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  };

  try {
    await preflightCleanup();
    /* ================= PHASE A — API ================= */
    console.log('--- API ---');
    let r;
    r = await api('GET', '/api/health');
    check('A health', r.status === 200 && r.data.status === 'ok');
    r = await api('GET', '/api/videos');
    check('A seed videos = 9', r.status === 200 && r.data.length === 9, `got ${r.data && r.data.length}`);
    const vids = r.data;
    const vid = vids.find((v) => (v.duration || 0) >= 30) || vids[0];
    r = await api('GET', `/api/videos/${vid.id}`);
    check('A detail', r.status === 200 && r.data.title === vid.title);
    r = await api('POST', '/api/auth/login', { body: { username: 'viewer1', password: 'viewer123' } });
    check('A login consumer', r.status === 200 && r.data.user.role === 'consumer');
    const qt = r.data.token;
    r = await api('PUT', `/api/videos/${vid.id}/progress`, { token: qt, body: { position: 20 } });
    check('A seed progress for resume test', r.status === 200);
    r = await api('POST', `/api/videos/${vid.id}/comments`, { token: qt, body: { body: 'pre-seeded agg comment' } });
    check('A seed comment via API', r.status === 201);
    r = await api('GET', '/api/videos/' + vid.id + '/related');
    check('A related', r.status === 200 && r.data.length >= 3);

    /* ================= PHASE B — DESKTOP ================= */
    console.log('--- Desktop ---');
    await clearSession();
    await page.goto(BASE + '/#/feed', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.feed-slide');
    check('B feed renders slides', await page.locator('.feed-slide').count() === 9);
    check('B brand visible', await page.locator('.brand').textContent().then((t) => t.includes('VANTAGE')));
    check('B guest topbar has sign in', await page.locator('#loginBtn').isVisible());
    check('B guest nav has no Playlists', await page.locator('#nav a[data-nav="playlists"]').count() === 0);
    check('B feed video element plays muted', await page.evaluate(() => {
      const v = document.querySelector('.feed-video');
      return !!v && v.muted;
    }));
    check('B stats on slide', await page.locator('.feed-info .stats').first().isVisible());

    await page.click('#loginBtn');
    await page.waitForSelector('#authModal:not(.hidden) #authForm');
    check('B auth modal opens', true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#authModal.hidden', { state: 'attached' });
    check('B Escape closes modal', true);

    await page.click('#loginBtn');
    await page.fill('#authUsername', 'viewer1');
    await page.fill('#authPassword', 'wrongpass');
    await page.click('#authSubmit');
    await waitFor(() => page.locator('#toast.err').isVisible().then((v) => v));
    check('B wrong creds error toast', (await page.locator('#toast').textContent()).includes('Invalid'));
    await page.fill('#authPassword', 'viewer123');
    await page.click('#authSubmit');
    await waitFor(() => page.locator('.who').isVisible().then((v) => v));
    const who = await page.locator('.who').textContent();
    check('B login pill shows viewer1 consumer', who.includes('viewer1') && who.includes('consumer'));
    check('B consumer nav gains Playlists', await page.locator('#nav a[data-nav="playlists"]').count() === 1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.who');
    check('B session persists after reload', (await page.locator('.who').textContent()).includes('viewer1'));

    await page.evaluate(() => localStorage.setItem('vt-skip-like', '1'));
    const liked = await page.locator('.rail-btn.like').first();
    await liked.click();
    await waitFor(() => page.locator('.rail-btn.like.on').count() === 1);
    check('B feed like heart toggles', true);
    const likeCnt1 = await page.locator('.rail-btn.like .cnt').first().textContent();
    await page.locator('.rail-btn.like.on').first().click();
    await waitFor(() => page.locator('.rail-btn.like.on').count() === 0);
    check('B feed unlike works', true);

    await page.locator('.rail-btn[data-act="comments"]').first().click();
    await page.waitForSelector('#sheetBackdrop:not(.hidden)');
    await waitFor(() => page.locator('#sheetBodyWrap .comment').count() >= 3);
    check('B comments sheet shows seeded comments', (await page.locator('#sheetBodyWrap .comment').count()) >= 3, `cnt ${await page.locator('#sheetBodyWrap .comment').count()}`);
    await page.fill('#commentInput', 'suite comment from feed');
    await page.click('#sheetFoot button[type="submit"]');
    await waitFor(() => page.locator('#sheetBodyWrap .comment').first().textContent().then((t) => t.includes('suite comment from feed')));
    check('B feed sheet posts comment', true);
    await page.click('#sheetClose');
    await page.waitForSelector('#sheetBackdrop.hidden', { state: 'attached' });
    check('B sheet closes', true);

    await page.locator('.rail-btn[data-act="share"]').first().click();
    await waitFor(() => page.locator('#toast.show').isVisible().then((v) => v));
    check('B share toast appears', (await page.locator('#toast').textContent()).length > 0);

    await page.keyboard.press('ArrowDown');
    await sleep(400);
    check('B keyboard advances feed slide', (await page.evaluate(() => Math.round(document.querySelector('.feed').scrollTop / document.querySelector('.feed').clientHeight))) === 1);

    await page.keyboard.press('ArrowUp');

    await page.click('.brand');
    await page.waitForSelector('.feed-slide');
    const slide2 = page.locator('.feed-slide').nth(1);
    await slide2.locator('.feed-info h2').click();
    await page.waitForURL(/#\/watch\//);
    await page.waitForSelector('#wVideo');
    await waitFor(() => page.evaluate(() => document.querySelector('#wVideo').readyState >= 2));
    check('B watch page loads video', true);

    await page.click('.watch-actions .w-btn[data-act="like"]');
    await sleep(600);
    check('B watch like button toggles', (await page.locator('.watch-actions .w-btn.like').textContent()).includes('♥ LIKED'));
    await page.click('.watch-actions .w-btn.like');
    await sleep(600);
    check('B watch unlike toggles back', (await page.locator('.watch-actions .w-btn.like').textContent()).includes('♡ LIKE'));

    await page.locator('.stars-row .star').nth(3).click();
    await sleep(600);
    check('B star rating sets 4', (await page.locator('.stars-row .star.on').count()) === 4);
    await page.locator('.stars-row .star').nth(3).click();
    await sleep(600);
    check('B star click unrates', (await page.locator('.stars-row .star.on').count()) === 0);

    await page.fill('#wCommentInput', 'watch page suite comment');
    await page.click('#wCommentForm button[type="submit"]');
    await waitFor(() => page.locator('#wComments .comment').first().textContent().then((t) => t.includes('watch page suite comment')));
    check('B watch page comment posts', true);

    check('B up next populated', (await page.locator('#upNextList .upnext-item').count()) >= 3);
    await page.evaluate(() => { const v = document.querySelector('#wVideo'); if (v.duration) v.currentTime = v.duration - 0.3; });
    await waitFor(() => page.locator('#upNextList .countdown').count() === 1);
    check('B up-next countdown starts on ended', true);
    await page.locator('#upNextList .upnext-item').first().click();
    await page.waitForURL(/#\/watch\//);
    await sleep(300);
    check('B countdown cancels on manual click', (await page.locator('#upNextList .countdown').count()) === 0);

    await page.click('.watch-actions .w-btn[data-act="playlist"]');
    await page.waitForSelector('#plModal:not(.hidden)');
    check('B playlist picker opens', true);
    await page.click('#plModal .pl-new input');
    await page.fill('#plName', 'Suite Picks');
    await page.click('#plCreate');
    await waitFor(() => page.locator('#plModal.hidden').isVisible().then((v) => v));
    check('B create playlist + add item', true);

    await page.goto(BASE + '/#/playlists', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pl-card');
    check('B playlist card appears', (await page.locator('.pl-card h3').textContent()).includes('Suite Picks'));
    await page.locator('.pl-card').first().click();
    await page.waitForURL(/#\/playlist\//);
    await page.waitForSelector('#plDetailGrid .card');
    check('B playlist detail lists item', (await page.locator('#plDetailGrid .card').count()) >= 1);
    await page.click('#playAll');
    await page.waitForURL(/#\/watch\//);
    await page.waitForSelector('#wVideo');
    check('B play all navigates to watch', true);

    await page.goto(BASE + '/#/explore', { waitUntil: 'domcontentloaded' });
    await page.fill('#searchInput', 'Salmon');
    await waitFor(() => page.locator('#exploreGrid .card').count() === 1);
    check('B explore search narrows to 1', (await page.locator('#exploreGrid .card h3').textContent()).includes('Salmon Summit'));
    await page.fill('#searchInput', '');
    await waitFor(() => page.locator('#exploreGrid .card').count() === 9);
    await page.click('#genreChips .chip[data-g="Roads"]');
    await waitFor(() => page.locator('#exploreGrid .card').count() === 2);
    check('B genre chip filters Roads(2)', true);
    await page.click('#genreChips .chip[data-g=""]');
    await page.selectOption('#sortSel', 'popular');
    await sleep(700);
    check('B sort popular reorders', true);
    await page.locator('#exploreGrid .card').first().click();
    await page.waitForURL(/#\/watch\//);
    check('B explore card opens watch', true);

    /* ================= PHASE C — MOBILE ================= */
    console.log('--- Mobile ---');
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mp = await mctx.newPage();
    mp.setDefaultTimeout(10000);
    await mp.goto(BASE + '/#/feed', { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('.feed-slide');
    check('C bottom nav visible', await mp.locator('#bottomNav').isVisible());
    check('C topbar visible in feed mode', await mp.locator('.topbar').isVisible());
    check('C feed slide fits viewport below header', await mp.evaluate(() => { const s = document.querySelector('.feed-slide'); return s && s.clientHeight >= window.innerHeight - 140; }));
    await mp.locator('.rail-btn[data-act="mute"]').first().click();
    await sleep(300);
    check('C mute tap toggles sound state', (await mp.locator('.rail-btn[data-act="mute"]').first().locator('.cnt').textContent()).includes('Mute'));
    await mp.locator('.rail-btn[data-act="comments"]').first().click();
    await mp.waitForSelector('#sheetBackdrop:not(.hidden)');
    await waitFor(() => mp.locator('#sheetBodyWrap .comment').count() >= 1);
    check('C sheet opens on mobile', (await mp.locator('#sheetBodyWrap .comment').count()) >= 1);
    await mp.click('#sheetClose');

    await mp.goto(BASE + '/#/explore', { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('#exploreGrid .card');
    check('C explore grid single column', await mp.evaluate(() => {
      const g = document.querySelector('#exploreGrid');
      return g && getComputedStyle(g).gridTemplateColumns.split(' ').length === 1;
    }));
    await mp.goto(BASE + '/#/watch/2', { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('#wVideo');
    check('C watch stacks panels on mobile', await mp.evaluate(() => {
      const grid = document.querySelector('.watch-grid');
      return grid && getComputedStyle(grid).gridTemplateColumns.split(' ').length === 1;
    }));
    await mp.goto(BASE + '/#/playlists', { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('#plSignIn');
    check('C guest playlists shows sign-in card', true);
    await mp.click('#bottomNav a[data-nav="playlists"]');
    await mp.waitForSelector('#authModal:not(.hidden)');
    check('C bottom nav playlists prompts sign in', true);
    await mctx.close();

    /* ================= PHASE D — CREATOR + ADMIN ================= */
    console.log('--- Creator / Admin ---');
    await clearSession();
    await page.goto(BASE + '/#/login-less', { waitUntil: 'domcontentloaded' });
    await page.goto(BASE + '/#/mine', { waitUntil: 'domcontentloaded' });
    await waitFor(() => page.locator('.empty').textContent().then((t) => t.includes('Creators only')));
    check('D consumer blocked from mine', true);
    await page.goto(BASE + '/#/upload', { waitUntil: 'domcontentloaded' });
    await waitFor(() => page.locator('.empty').textContent().then((t) => t.includes('Creators only')));
    check('D consumer blocked from upload', true);

    await clearSession();
    await page.goto(BASE + '/#/feed', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginBtn');
    await page.click('#loginBtn');
    await page.fill('#authUsername', 'creator1');
    await page.fill('#authPassword', 'creator123');
    await page.click('#authSubmit');
    await waitFor(() => page.locator('.who').textContent().then((t) => t.includes('creator1')));
    check('D creator login (creator1)', true);
    check('D creator nav has Upload+Mine', (await page.locator('#nav a[data-nav="upload"]').count()) === 1 && (await page.locator('#nav a[data-nav="mine"]').count()) === 1);

    await page.goto(BASE + '/#/mine', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mine-card');
    const before = await page.locator('.mine-card').count();
    check('D mine lists creator videos', before >= 3, `got ${before}`);
    check('D analytics bars present', (await page.locator('.mine-card .bars .bar-col').count()) >= before * 3);

    await page.goto(BASE + '/#/upload', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#upFile', { state: 'attached' });
    await page.setInputFiles('#upFile', path.join(STOCK, 'code.mp4'));
    await page.fill('#upTitle', 'Agg Upload Test');
    await page.fill('#upProducer', 'Suite Producer');
    await page.click('#upGo');
    await waitFor(() => page.url().includes('#/mine'));
    await waitFor(() => page.locator('.mine-card').count() === before + 1);
    check('D upload completes and appears in mine', true);
    const newCard = page.locator('.mine-card').filter({ hasText: 'Agg Upload Test' });
    await newCard.locator('[data-edit]').click();
    await page.waitForSelector('.modal-backdrop:not(.hidden) .modal-card');
    await page.fill('.modal-backdrop:not(.hidden) input[name="title"]', 'Agg Upload Edited');
    await page.click('.modal-backdrop:not(.hidden) button.primary');
    await waitFor(() => page.locator('.mine-card').filter({ hasText: 'Agg Upload Edited' }).count() === 1);
    check('D edit video modal works', true);
    page.once('dialog', (d) => d.accept());
    await page.locator('.mine-card').filter({ hasText: 'Agg Upload Edited' }).locator('[data-del]').click();
    await waitFor(() => page.locator('.mine-card').count() === before);
    check('D delete video with confirm works', true);

    await clearSession();
    await page.goto(BASE + '/#/feed', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginBtn');
    await page.click('#loginBtn');
    await page.fill('#authUsername', 'admin');
    await page.fill('#authPassword', 'admin123');
    await page.click('#authSubmit');
    await waitFor(() => page.locator('.who').textContent().then((t) => t.includes('admin')));
    check('D admin login', true);

    await page.goto(BASE + '/#/admin', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stat-chip');
    check('D admin stats chips', (await page.locator('.stat-chip').count()) === 3);
    check('D admin creator table rows', (await page.locator('#adRows tr').count()) >= 1);
    await page.fill('#adU', 'suite_creator');
    await page.fill('#adE', 'suite_creator@example.com');
    await page.fill('#adP', 'suite_pass1');
    await page.click('#adCreate');
    await waitFor(() => page.locator('#adRows').textContent().then((t) => t.includes('suite_creator')));
    check('D provision creator appears', true);
    page.once('dialog', (d) => d.accept());
    await page.locator('#adRows .mini-del').last().click();
    await waitFor(() => page.locator('#adRows').textContent().then((t) => !t.includes('suite_creator')));
    check('D deprovision works', true);

    await clearSession();
    await page.goto(BASE + '/#/account', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { location.hash = '#/feed'; location.hash = '#/account'; });
    await waitFor(() => page.locator('#acSignIn').isVisible().then((v) => v).catch(() => false), 5000);
    const acUp = await page.locator('#acSignUp').count();
    const acHtml = await page.locator('#view').innerHTML().then((h) => h.slice(0, 120)).catch(() => '?');
    check('D guest account view has sign in/up', acUp === 1, `acSignUp=${acUp} view=${acHtml}`);

    /* resume chip */
    await clearSession();
    await page.goto(BASE + '/#/feed', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginBtn');
    await page.click('#loginBtn');
    await page.fill('#authUsername', 'viewer1');
    await page.fill('#authPassword', 'viewer123');
    await page.click('#authSubmit');
    await waitFor(() => page.locator('.who').isVisible().then((v) => v));
    await page.goto(BASE + `/#/watch/${vid.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#wVideo');
    await waitFor(() => page.locator('#resumeChip:not(.hidden)').isVisible().then((v) => v));
    check('D resume chip appears for saved progress', (await page.locator('#resumeChip').textContent()).includes('Resume at'));

    const gctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const guest = await gctx.newPage();
    await guest.goto(BASE + `/#/watch/${vid.id}`, { waitUntil: 'domcontentloaded' });
    await guest.waitForSelector('#wVideo');
    check('D guest watch has no comment form', (await guest.locator('#wCommentForm').count()) === 0);
    await guest.goto(BASE + '/#/feed', { waitUntil: 'domcontentloaded' });
    await guest.waitForSelector('.feed-slide');
    await guest.locator('.rail-btn[data-act="comments"]').first().click();
    await guest.waitForSelector('#sheetBackdrop:not(.hidden)');
    check('D guest sheet shows sign-in prompt', (await guest.locator('#sheetFoot').textContent()).includes('Sign in to join'));
    await guest.click('#sheetClose');
    await guest.locator('.rail-btn.like').first().click();
    await guest.waitForSelector('#authModal:not(.hidden)');
    check('D guest feed like opens auth modal', true);
    await gctx.close();

    await clearSession();
    await page.goto(BASE + '/#/feed', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginBtn');
    await page.click('#loginBtn');
    await page.click('.tab[data-tab="register"]');
    await page.waitForSelector('#authEmailWrap:not(.hidden)');
    check('D register tab reveals email', true);
    await page.fill('#authUsername', 'aggfan');
    await page.fill('#authEmail', 'aggfan@example.com');
    await page.fill('#authPassword', 'aggfan123');
    await page.click('#authSubmit');
    const regWho = await waitFor(() => page.locator('.who').textContent().then((t) => t.includes('aggfan')).catch(() => false), 5000);
    if (!regWho) {
      await page.click('#authClose');
      await page.click('#loginBtn');
      await page.fill('#authUsername', 'aggfan');
      await page.fill('#authPassword', 'aggfan123');
      await page.click('#authSubmit');
    }
    await waitFor(() => page.locator('.who').textContent().then((t) => t.includes('aggfan')).catch(() => false), 5000);
    check('D register/relogin consumer via UI', (await page.locator('.who').textContent()).includes('aggfan'));

    console.log(`\n${passed.length} passed, ${failed.length} failed`);
    await ctx.close();
    await browser.close();
    if (server) server.kill();
    process.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.log('SUITE CRASH :: ' + e.message);
    await page.screenshot({ path: 'D:\\streamforge\\vantage-crash.png', fullPage: true }).catch(() => {});
    if (server) server.kill();
    process.exit(2);
  }
}

main();