(() => {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n ?? 0));
  const fmtTime = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const ago = (sql) => {
    const t = Date.now() - new Date(String(sql).replace(' ', 'T') + 'Z').getTime();
    const m = Math.floor(t / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    const d = Math.floor(h / 24);
    return d < 7 ? d + 'd' : String(sql).slice(0, 10);
  };
  const thumbUrl = (id) => '/api/videos/' + id + '/thumb';

  const state = {
    token: localStorage.getItem('vt-token') || null,
    user: null,
    videos: [],
    meta: { genres: [], ageRatings: [] },
    muted: true,
    viewed: new Set(),
    timers: new Set(),
  };
  try { state.user = JSON.parse(localStorage.getItem('vt-user') || 'null'); } catch { state.user = null; }
  const role = () => (state.user ? state.user.role : 'guest');

  const toastEl = $('#toast');
  let toastTimer = null;
  function toast(msg, type) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 2600);
  }

  async function api(path, opts = {}) {
    const headers = opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const res = await fetch(path, { ...opts, headers });
    let data = null;
    try { data = await res.json(); } catch { }
    if (res.status === 401 && !path.includes('/auth/')) {
      logout(false);
      openAuth('login', 'Your session expired — sign in again');
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
    return data;
  }

  function saveSession(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem('vt-token', token);
    localStorage.setItem('vt-user', JSON.stringify(user));
    renderChrome();
  }
  function logout(silent) {
    state.token = null;
    state.user = null;
    localStorage.removeItem('vt-token');
    localStorage.removeItem('vt-user');
    renderChrome();
    render();
    if (!silent) toast('Signed out');
  }

  /* ---------------- auth modal ---------------- */
  let authMode = 'login';
  function openAuth(mode, msg) {
    authMode = mode || 'login';
    $('#authModal').classList.remove('hidden');
    $('#authTitle').textContent = authMode === 'login' ? 'Sign in to Vantage' : 'Create your account';
    $('#authSubmit').textContent = authMode === 'login' ? 'Sign in' : 'Create account';
    $('#authEmailWrap').classList.toggle('hidden', authMode === 'login');
    $('#authPassword').setAttribute('autocomplete', authMode === 'login' ? 'current-password' : 'new-password');
    $('#authHint').textContent = authMode === 'login' ? 'Creator accounts are provisioned by an administrator.' : 'Consumer accounts are free — creators are provisioned by admins.';
    $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === authMode));
    $('#authUsername').focus();
    if (msg) toast(msg);
  }
  function closeAuth() { $('#authModal').classList.add('hidden'); }
  function openSheet() { $('#sheetBackdrop').classList.remove('hidden'); }
  function closeSheet() { $('#sheetBackdrop').classList.add('hidden'); }
  function openPlModal() { $('#plModal').classList.remove('hidden'); }
  function closePlModal() { $('#plModal').classList.add('hidden'); }

  /* ---------------- chrome ---------------- */
  const NAV_ITEMS = [
    { key: 'feed', label: 'Feed' },
    { key: 'explore', label: 'Explore' },
    { key: 'playlists', label: 'Playlists', authed: true },
    { key: 'upload', label: 'Upload', roles: ['creator', 'admin'] },
    { key: 'mine', label: 'My Videos', roles: ['creator', 'admin'] },
    { key: 'admin', label: 'Admin', roles: ['admin'] },
  ];
  function renderChrome() {
    const r = role();
    const nav = $('#nav');
    nav.innerHTML = '';
    for (const item of NAV_ITEMS) {
      if (item.authed && !state.user) continue;
      if (item.roles && !item.roles.includes(r)) continue;
      const a = document.createElement('a');
      a.textContent = item.label;
      a.href = '#/' + item.key;
      a.dataset.nav = item.key;
      nav.appendChild(a);
    }
    const box = $('#userbox');
    box.innerHTML = '';
    if (state.user) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = state.user.username + ' ';
      const rl = document.createElement('span');
      rl.className = 'role';
      rl.textContent = state.user.role;
      who.appendChild(rl);
      box.appendChild(who);
      const out = document.createElement('button');
      out.textContent = 'Sign out';
      out.addEventListener('click', () => logout());
      box.appendChild(out);
    } else {
      const b = document.createElement('button');
      b.className = 'primary';
      b.id = 'loginBtn';
      b.textContent = 'Sign in';
      b.addEventListener('click', () => openAuth('login'));
      box.appendChild(b);
      const s = document.createElement('button');
      s.id = 'signupBtn';
      s.textContent = 'Sign up';
      s.addEventListener('click', () => openAuth('register'));
      box.appendChild(s);
    }
    setNavCur();
  }
  function setNavCur() {
    const view = currentView();
    $$('[data-nav]').forEach((el) => { el.dataset.cur = el.dataset.nav === view ? '1' : '0'; });
    $$('#bottomNav a').forEach((el) => { el.dataset.cur = el.dataset.nav === view ? '1' : '0'; });
  }
  function currentView() {
    const h = location.hash.replace(/^#\//, '');
    const v = h.split('/')[0] || 'feed';
    return ['feed', 'watch', 'explore', 'playlists', 'playlist', 'upload', 'mine', 'admin', 'account'].includes(v) ? v : 'feed';
  }

  /* ---------------- router ---------------- */
  const ROUTES = {
    feed: renderFeed, watch: renderWatch, explore: renderExplore,
    playlists: renderPlaylists, playlist: renderPlaylist,
    upload: renderUpload, mine: renderMine, admin: renderAdmin, account: renderAccount,
  };
  function render() {
    clearTimers();
    closeSheet();
    closeAuth();
    closePlModal();
    const h = location.hash.replace(/^#\//, '');
    const parts = h.split('/');
    const v = parts[0] || 'feed';
    const id = parts[1];
    const target = $('#view');
    $('#app').classList.toggle('feed-mode', v === 'feed');
    const fn = ROUTES[v] || renderFeed;
    fn(target, v, id);
    setNavCur();
    window.scrollTo(0, 0);
  }
  function later(fn, ms) { const t = setTimeout(fn, ms); state.timers.add(t); return t; }
  function every(fn, ms) { const t = setInterval(fn, ms); state.timers.add(t); return t; }
  function clearTimers() { state.timers.forEach(clearTimeout); state.timers.forEach(clearInterval); state.timers.clear(); }

  /* ---------------- shared bits ---------------- */
  function cardHtml(v) {
    return `<div class="card" data-id="${v.id}" data-goto="watch">
      <div class="thumb">
        <img src="${thumbUrl(v.id)}" alt="" loading="lazy" onerror="this.outerHTML=''">
        <span class="play-ic">▶</span>
        <span class="age">${esc(v.ageRating)}</span>
      </div>
      <div class="body">
        <h3>${esc(v.title)}</h3>
        <div class="meta">${esc(v.genre)} · ${esc(v.publisher)}</div>
        <div class="stats">${fmt(v.views)} views · ★ ${Number(v.avgRating || 0).toFixed(1)} (${fmt(v.ratingCount)}) · ♥ ${fmt(v.likeCount)}</div>
      </div>
    </div>`;
  }
  function gridInto(target, videos) {
    if (!videos.length) { target.innerHTML = '<div class="empty">Nothing here yet.</div>'; return; }
    target.innerHTML = videos.map(cardHtml).join('');
  }
  function goto(hash) { location.hash = hash; }

  function shareVideo(v) {
    const url = location.origin + '#/watch/' + v.id;
    if (navigator.share) {
      navigator.share({ title: v.title, url }).catch(() => {});
      return;
    }
    const done = (ok) => { toast(ok ? 'Link copied' : url, ok ? 'ok' : 'err'); };
    try {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      done(ok);
    } catch {
      if (navigator.clipboard) { navigator.clipboard.writeText(url).then(() => done(true)).catch(() => done(false)); }
      else done(false);
    }
  }

  async function rateVideo(videoId, stars) {
    if (!state.user || role() !== 'consumer') { toast('Sign in to rate'); openAuth('login'); return; }
    const res = await api('/api/videos/' + videoId + '/rating', { method: 'POST', body: JSON.stringify({ stars }) });
    toast(stars === 0 ? 'Rating removed' : 'Rated ' + stars + '★', 'ok');
    return res;
  }

  /* ---------------- FEED ---------------- */
  let feedEl = null, feedVideos = [], feedIndex = 0;
  async function renderFeed(target) {
    target.innerHTML = '<div class="empty">Loading feed…</div>';
    let data = state.videos;
    if (!data.length) { try { data = await api('/api/videos?sort=latest'); state.videos = data; } catch (e) { target.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; return; } }
    feedVideos = data;
    feedIndex = 0;
    if (!feedVideos.length) { target.innerHTML = '<div class="empty">No videos yet.</div>'; return; }
    feedEl = document.createElement('div');
    feedEl.className = 'feed';
    feedEl.tabIndex = 0;
    feedEl.innerHTML = feedVideos.map((v, i) => slideHtml(v, i)).join('');
    target.replaceChildren(feedEl);
    feedEl.addEventListener('scroll', onFeedScroll);
    feedEl.addEventListener('click', onFeedClick);
    const first = feedEl.querySelector('video');
    if (first) { first.muted = true; first.play().catch(() => {}); }
  }
  function slideHtml(v, i) {
    const liked = v.myRating === 5;
    return `<section class="feed-slide" data-id="${v.id}">
      <div class="feed-box">
        <video class="feed-video" src="/api/videos/${v.id}/stream" muted playsinline preload="metadata" data-index="${i}"></video>
        <div class="veil"></div>
        <div class="feed-info">
          <div class="chips"><span class="chip">${esc(v.genre)}</span><span class="chip">${esc(v.ageRating)}</span></div>
          <h2>${esc(v.title)}</h2>
          <div class="pub">${esc(v.producer)} · ${esc(v.publisher)}</div>
          <div class="stats">${fmt(v.views)} views · ★ ${Number(v.avgRating || 0).toFixed(1)} · ${fmt(v.commentCount)} comments</div>
        </div>
        <div class="feed-rail">
          <button class="rail-btn like ${liked ? 'on' : ''}" data-act="like"><span class="ic">${liked ? '♥' : '♡'}</span><span class="cnt">${fmt(v.likeCount)}</span></button>
          <button class="rail-btn" data-act="comments"><span class="ic">💬</span><span class="cnt">${fmt(v.commentCount)}</span></button>
          <button class="rail-btn" data-act="share"><span class="ic">↗</span><span class="cnt">Share</span></button>
          <button class="rail-btn" data-act="mute"><span class="ic">${state.muted ? '🔇' : '🔊'}</span><span class="cnt">${state.muted ? 'Unmute' : 'Mute'}</span></button>
        </div>
        <div class="feed-progress"><div class="fill" data-pb="${v.id}"></div></div>
      </div>
    </section>`;
  }
  function onFeedScroll() {
    const h = feedEl.clientHeight;
    if (!h) return;
    const idx = Math.round(feedEl.scrollTop / h);
    if (idx === feedIndex || idx < 0 || idx >= feedVideos.length) return;
    feedIndex = idx;
    feedEl.querySelectorAll('video').forEach((vd, i) => {
      if (i === idx) { vd.muted = state.muted; vd.play().catch(() => {}); }
      else vd.pause();
    });
  }
  function onFeedClick(e) {
    const videoEl = feedEl.querySelector('.feed-slide:nth-child(' + (feedIndex + 1) + ') video');
    const railBtn = e.target.closest('.rail-btn');
    if (railBtn) {
      const v = feedVideos[feedIndex];
      const act = railBtn.dataset.act;
      if (act === 'like') { toggleFeedLike(railBtn, v); }
      else if (act === 'comments') { openCommentsSheet(v); }
      else if (act === 'share') { shareVideo(v); }
      else if (act === 'mute') { toggleFeedMute(railBtn); }
      return;
    }
    if (e.target.closest('.feed-info')) {
      goto('#/watch/' + feedVideos[feedIndex].id);
      return;
    }
    if (videoEl) { videoEl.paused ? videoEl.play().catch(() => {}) : videoEl.pause(); }
  }
  async function toggleFeedLike(btn, v) {
    const isOn = btn.classList.contains('on');
    try {
      const res = await rateVideo(v.id, isOn ? 0 : 5);
      if (!res) return;
      v.myRating = isOn ? 0 : 5;
      v.likeCount = Math.max(0, v.likeCount + (isOn ? -1 : 1));
      v.avgRating = res.avgRating; v.ratingCount = res.ratingCount;
      btn.classList.toggle('on', !isOn);
      btn.querySelector('.ic').textContent = !isOn ? '♥' : '♡';
      btn.querySelector('.cnt').textContent = fmt(v.likeCount);
    } catch (err) { toast(err.message, 'err'); }
  }
  function toggleFeedMute(btn) {
    state.muted = !state.muted;
    feedEl.querySelectorAll('video').forEach((vd) => { vd.muted = state.muted; });
    btn.querySelector('.ic').textContent = state.muted ? '🔇' : '🔊';
    btn.querySelector('.cnt').textContent = state.muted ? 'Unmute' : 'Mute';
    if (!state.muted) toast('Sound on — enjoy');
  }
  function bindFeedProgress() {
    const vd = feedEl && feedEl.querySelector('.feed-slide:nth-child(' + (feedIndex + 1) + ') video');
    if (!vd) return;
    vd.ontimeupdate = () => {
      const fill = feedEl.querySelector('.feed-progress .fill');
      if (fill && vd.duration) fill.style.width = Math.min(100, (vd.currentTime / vd.duration) * 100) + '%';
    };
    vd.onended = () => {
      if (feedIndex < feedVideos.length - 1) {
        feedEl.scrollTo({ top: (feedIndex + 1) * feedEl.clientHeight, behavior: 'smooth' });
        feedIndex += 1;
        onFeedScroll();
      } else {
        toast('End of the feed — explore more', 'ok');
      }
    };
  }

  /* ---------------- comments sheet ---------------- */
  let sheetVideo = null;
  async function openCommentsSheet(v) {
    sheetVideo = v;
    openSheet();
    $('#sheetCount').textContent = fmt(v.commentCount);
    $('#sheetBodyWrap').innerHTML = '<div class="empty">Loading comments…</div>';
    const foot = $('#sheetFoot');
    foot.innerHTML = '';
    if (state.user && role() === 'consumer') {
      foot.innerHTML = `<form class="comment-form"><input id="commentInput" maxlength="500" placeholder="Add a comment…"><button type="submit">Post</button></form>`;
      foot.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = $('#commentInput');
        const text = input.value.trim();
        if (!text) return;
        try {
          const c = await api('/api/videos/' + v.id + '/comments', { method: 'POST', body: JSON.stringify({ body: text }) });
          v.commentCount += 1;
          $('#sheetCount').textContent = fmt(v.commentCount);
          input.value = '';
          prependComment(c);
          toast('Comment posted', 'ok');
        } catch (err) { toast(err.message, 'err'); }
      });
    } else if (!state.user) {
      foot.innerHTML = `<p class="sheet-sign">Sign in to join the conversation.</p>`;
    }
    try {
      const list = await api('/api/videos/' + v.id + '/comments');
      renderCommentList(list);
    } catch (err) { $('#sheetBodyWrap').innerHTML = '<div class="error-box">' + esc(err.message) + '</div>'; }
  }
  function commentHtml(c) {
    const canDel = state.user && (state.user.role === 'admin' || state.user.username === c.username);
    return `<li class="comment" data-id="${c.id}">
      <div class="cm"><strong>${esc(c.username)}</strong><span class="ago">${ago(c.createdAt)}</span>${canDel ? `<button class="mini-del" data-del="${c.id}">delete</button>` : ''}</div>
      <p>${esc(c.body)}</p>
    </li>`;
  }
  function renderCommentList(list) {
    const wrap = $('#sheetBodyWrap');
    wrap.innerHTML = list.length ? list.map(commentHtml).join('') : '<div class="empty">No comments yet — be the first.</div>';
    $$('.mini-del', wrap).forEach((b) => b.addEventListener('click', delComment));
  }
  function prependComment(c) {
    const wrap = $('#sheetBodyWrap');
    if (wrap.querySelector('.empty')) wrap.innerHTML = '';
    wrap.insertAdjacentHTML('afterbegin', commentHtml(c));
    wrap.querySelector('.mini-del').addEventListener('click', delComment);
  }
  async function delComment(e) {
    const id = e.target.dataset.del;
    if (!confirm('Delete this comment?')) return;
    try {
      await api('/api/comments/' + id, { method: 'DELETE' });
      const li = e.target.closest('.comment');
      li.remove();
      if (sheetVideo) { sheetVideo.commentCount = Math.max(0, sheetVideo.commentCount - 1); $('#sheetCount').textContent = fmt(sheetVideo.commentCount); }
      toast('Comment deleted', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* ---------------- WATCH ---------------- */
  let watchVideo = null, watchRelated = [], progressTimer = null, countdownTimer = null, upNextIndex = 0;
  async function renderWatch(target, view, id) {
    target.innerHTML = '<div class="empty">Loading…</div>';
    let v, related;
    try { v = await api('/api/videos/' + id); related = await api('/api/videos/' + id + '/related'); }
    catch (err) { target.innerHTML = '<div class="error-box">' + esc(err.message) + '</div>'; return; }
    watchVideo = v;
    watchRelated = related;
    upNextIndex = 0;
    const isConsumer = role() === 'consumer';
    target.innerHTML = `<div class="watch-grid">
      <div class="main-col">
        <div class="stage">
          <video id="wVideo" src="/api/videos/${v.id}/stream" preload="metadata" playsinline controls></video>
          <button class="resume-chip hidden" id="resumeChip"></button>
        </div>
        <h1 class="watch-title">${esc(v.title)}</h1>
        <div class="watch-meta">
          <span>${esc(v.genre)}</span> · <span>${esc(v.producer)} · ${esc(v.publisher)}</span> · <span>${esc(v.ageRating)}</span> ·
          <span>${fmt(v.views)} views</span>
        </div>
        <div class="watch-actions">
          <button class="w-btn" data-act="feed">← FEED</button>
          <button class="w-btn" data-act="share">SHARE</button>
          ${state.user ? '<button class="w-btn" data-act="playlist">+ PLAYLIST</button>' : ''}
          ${isConsumer ? `<button class="w-btn like" data-act="like" data-on="${v.myRating === 5 ? '1' : '0'}">${v.myRating === 5 ? '♥ LIKED' : '♡ LIKE'}</button>` : ''}
          ${isConsumer ? '<span class="stars-row" data-act="stars"></span>' : ''}
        </div>
        <div class="panel">
          <h3>COMMENTS</h3>
          <ul class="comments" id="wComments"></ul>
          ${isConsumer ? `<form class="comment-form" id="wCommentForm"><input id="wCommentInput" maxlength="500" placeholder="Add a comment…"><button type="submit">Post</button></form>`
            : !state.user ? '<p class="sheet-sign">Sign in to comment.</p>' : ''}
        </div>
      </div>
      <aside class="side">
        <div class="panel">
          <h3>UP NEXT</h3>
          <div class="upnext" id="upNextList"></div>
        </div>
      </aside>
    </div>`;
    const stars = target.querySelector('.stars-row');
    if (stars) {
      for (let s = 1; s <= 5; s++) {
        const sp = document.createElement('span');
        sp.className = 'star' + (v.myRating >= s ? ' on' : '');
        sp.dataset.star = s;
        sp.textContent = '★';
        stars.appendChild(sp);
      }
      stars.addEventListener('click', onStarClick);
    }
    target.querySelector('.watch-actions').addEventListener('click', onWatchAction);
    const vid = target.querySelector('#wVideo');
    if (isConsumer && v.progress && v.progress > 8) {
      const chip = target.querySelector('#resumeChip');
      const aware = () => {
        if (vid.duration && v.progress < vid.duration - 5) {
          chip.textContent = 'Resume at ' + fmtTime(v.progress) + ' ›';
          chip.classList.remove('hidden');
          vid.removeEventListener('loadedmetadata', aware);
        }
      };
      vid.addEventListener('loadedmetadata', aware);
      chip.addEventListener('click', () => { vid.currentTime = v.progress; chip.classList.add('hidden'); vid.play().catch(() => {}); });
    }
    vid.addEventListener('play', () => {
      if (!state.viewed.has(v.id)) {
        state.viewed.add(v.id);
        api('/api/videos/' + v.id + '/view', { method: 'POST' }).then(() => { v.views += 1; }).catch(() => {});
      }
      if (isConsumer) {
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = every(() => saveProgress(vid), 5000);
      }
    });
    vid.addEventListener('pause', () => { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } });
    vid.addEventListener('ended', startCountdown);
    window.__vtVideo = vid;
    renderCommentsPanel(v);
    renderUpNext();
  }
  function saveProgress(vid) {
    if (state.user && role() === 'consumer' && watchVideo && vid && vid.currentTime > 0 && !vid.paused) {
      api('/api/videos/' + watchVideo.id + '/progress', { method: 'PUT', body: JSON.stringify({ position: Math.round(vid.currentTime) }) }).catch(() => {});
    }
  }
  function renderCommentsPanel(v) {
    api('/api/videos/' + v.id + '/comments').then((list) => {
      const ul = $('#wComments');
      if (!ul) return;
      ul.innerHTML = list.length ? list.map(commentHtml).join('') : '<li class="empty" style="padding:12px 0">No comments yet.</li>';
      $$('.mini-del', ul).forEach((b) => b.addEventListener('click', delComment));
    }).catch(() => {});
    const form = $('#wCommentForm');
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#wCommentInput');
      const text = input.value.trim();
      if (!text) return;
      try {
        const c = await api('/api/videos/' + v.id + '/comments', { method: 'POST', body: JSON.stringify({ body: text }) });
        input.value = '';
        v.commentCount += 1;
        const ul = $('#wComments');
        if (ul.querySelector('.empty')) ul.innerHTML = '';
        ul.insertAdjacentHTML('afterbegin', commentHtml(c));
        ul.querySelector('.mini-del').addEventListener('click', delComment);
        toast('Comment posted', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });
  }
  function renderUpNext() {
    const list = $('#upNextList');
    if (!list) return;
    if (!watchRelated.length) { list.innerHTML = '<div class="empty">Nothing else to watch.</div>'; return; }
    list.innerHTML = watchRelated.map((v, i) => `<div class="upnext-item" data-i="${i}">
      <div class="thumb"><img src="${thumbUrl(v.id)}" alt="" loading="lazy" onerror="this.outerHTML=''"></div>
      <div class="info"><b>${esc(v.title)}</b><span>${fmt(v.views)} views · ★ ${Number(v.avgRating || 0).toFixed(1)}</span></div>
    </div>`).join('');
    list.querySelectorAll('.upnext-item').forEach((el) => {
      el.addEventListener('click', () => { clearCountdown(); goto('#/watch/' + watchRelated[el.dataset.i].id); });
    });
  }
  function startCountdown() {
    clearCountdown();
    if (!watchRelated.length) return;
    let secs = 5;
    const list = $('#upNextList');
    if (list && list.children[0]) {
      list.children[0].insertAdjacentHTML('beforeend', `<span class="countdown">NEXT <span class="ring"></span> ${secs}</span>`);
    }
    toast('Up next in ' + secs, 'ok');
    countdownTimer = setInterval(() => {
      secs -= 1;
      const cd = list && list.querySelector('.countdown');
      if (cd) cd.lastChild.textContent = ' ' + secs;
      if (secs <= 0) { clearCountdown(); goto('#/watch/' + watchRelated[upNextIndex].id); }
    }, 1000);
  }
  function clearCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    const cd = $('#upNextList') && $('#upNextList').querySelector('.countdown');
    if (cd) cd.remove();
  }
  async function onStarClick(e) {
    const star = e.target.closest('.star');
    if (!star) return;
    let stars = Number(star.dataset.star);
    if (stars === watchVideo.myRating) stars = 0;
    try {
      const res = await rateVideo(watchVideo.id, stars);
      if (!res) return;
      watchVideo.myRating = stars;
      watchVideo.avgRating = res.avgRating;
      watchVideo.ratingCount = res.ratingCount;
      $$('.stars-row .star').forEach((sp) => sp.classList.toggle('on', Number(sp.dataset.star) <= stars));
      const likeBtn = $('.watch-actions .w-btn.like');
      if (likeBtn) syncLikeBtn(likeBtn, stars === 5);
    } catch (err) { toast(err.message, 'err'); }
  }
  async function onWatchAction(e) {
    const btn = e.target.closest('.w-btn');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'feed') goto('#/feed');
    else if (act === 'share') shareVideo(watchVideo);
    else if (act === 'playlist') openPlaylistPicker(watchVideo.id);
    else if (act === 'like') {
      const on = btn.dataset.on === '1';
      try {
        const res = await rateVideo(watchVideo.id, on ? 0 : 5);
        if (!res) return;
        watchVideo.myRating = on ? 0 : 5;
        watchVideo.avgRating = res.avgRating;
        syncLikeBtn(btn, !on);
      } catch (err) { toast(err.message, 'err'); }
    }
  }
  function syncLikeBtn(btn, on) {
    btn.dataset.on = on ? '1' : '0';
    btn.textContent = on ? '♥ LIKED' : '♡ LIKE';
  }

  /* ---------------- playlist picker ---------------- */
  let plVideoId = null;
  async function openPlaylistPicker(videoId) {
    plVideoId = videoId;
    openPlModal();
    $('#plName').value = '';
    const list = $('#plList');
    list.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const playlists = await api('/api/me/playlists?videoId=' + videoId);
      if (!playlists.length) { list.innerHTML = '<div class="empty">No playlists yet — create one below.</div>'; return; }
      list.innerHTML = playlists.map((p) => `<div class="pl-item ${p.containsVideo ? 'saved' : ''}" data-id="${p.id}" data-has="${p.containsVideo ? '1' : '0'}"><b>${esc(p.name)}</b><span class="cnt">${fmt(p.itemCount)}</span></div>`).join('');
      list.querySelectorAll('.pl-item').forEach((el) => el.addEventListener('click', onPlToggle));
    } catch (err) { list.innerHTML = '<div class="error-box">' + esc(err.message) + '</div>'; }
  }
  async function onPlToggle(e) {
    const el = e.target.closest('.pl-item');
    const id = el.dataset.id;
    const has = el.dataset.has === '1';
    try {
      if (has) await api('/api/playlists/' + id + '/items/' + plVideoId, { method: 'DELETE' });
      else await api('/api/playlists/' + id + '/items', { method: 'POST', body: JSON.stringify({ videoId: plVideoId }) });
      el.dataset.has = has ? '0' : '1';
      el.classList.toggle('saved', !has);
      toast(has ? 'Removed from playlist' : 'Added to playlist', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  /* ---------------- EXPLORE ---------------- */
  async function renderExplore(target) {
    let genres = state.meta.genres;
    if (!genres.length) { try { state.meta = await api('/api/meta'); genres = state.meta.genres; } catch { } }
    target.innerHTML = `<div class="page">
      <div class="page-head"><h1>EXPLORE</h1><p>Search, filter, discover — every frame counts.</p></div>
      <div class="toolbar">
        <input id="searchInput" placeholder="Search titles, producers, publishers…">
        <select id="sortSel"><option value="latest">Newest</option><option value="popular">Most viewed</option><option value="rating">Top rated</option></select>
      </div>
      <div class="chips" id="genreChips">
        <button class="chip on" data-g="">All</button>
        ${genres.map((g) => `<button class="chip" data-g="${esc(g)}">${esc(g)}</button>`).join('')}
      </div>
      <div class="grid" id="exploreGrid" style="margin-top:18px"></div>
    </div>`;
    const grid = target.querySelector('#exploreGrid');
    let timer = null;
    const load = async () => {
      const q = target.querySelector('#searchInput').value.trim();
      const g = target.querySelector('#genreChips .chip.on').dataset.g;
      const sort = target.querySelector('#sortSel').value;
      grid.innerHTML = '<div class="empty">Searching…</div>';
      try {
        const data = await api('/api/videos?q=' + encodeURIComponent(q) + '&genre=' + encodeURIComponent(g) + '&sort=' + sort);
        gridInto(grid, data);
      } catch (err) { grid.innerHTML = '<div class="error-box">' + esc(err.message) + '</div>'; }
    };
    target.querySelector('#searchInput').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
    target.querySelector('#sortSel').addEventListener('change', load);
    target.querySelector('#genreChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      $$('#genreChips .chip').forEach((c) => c.classList.toggle('on', c === chip));
      load();
    });
    grid.addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) goto('#/watch/' + c.dataset.id); });
    load();
  }

  /* ---------------- PLAYLISTS ---------------- */
  async function renderPlaylists(target) {
    if (!state.user) {
      target.innerHTML = `<div class="page"><div class="empty">
        <h1 style="font-family:var(--font-display);margin-bottom:10px">Playlists are for members</h1>
        <button class="w-btn primary" id="plSignIn">SIGN IN</button>
      </div></div>`;
      target.querySelector('#plSignIn').addEventListener('click', () => openAuth('login'));
      return;
    }
    target.innerHTML = `<div class="page">
      <div class="page-head"><h1>MY PLAYLISTS</h1><p>Your queues, collections and rewatch lists.</p></div>
      <div class="pl-new-row"><input id="plNewName" maxlength="80" placeholder="New playlist name…"><button class="w-btn primary" id="plNewBtn">CREATE</button></div>
      <div class="grid" id="plGrid"></div>
    </div>`;
    const grid = target.querySelector('#plGrid');
    const load = async () => {
      try {
        const list = await api('/api/me/playlists');
        if (!list.length) { grid.innerHTML = '<div class="empty">No playlists yet — create one above.</div>'; return; }
        grid.innerHTML = list.map((p) => `<div class="pl-card" data-id="${p.id}">
          <div class="cover">${p.coverVideoId ? `<img src="${thumbUrl(p.coverVideoId)}" alt="">` : '▤'}</div>
          <h3>${esc(p.name)}</h3>
          <div class="meta">${fmt(p.itemCount)} video${p.itemCount === 1 ? '' : 's'} · created ${ago(p.createdAt)}</div>
        </div>`).join('');
        grid.querySelectorAll('.pl-card').forEach((el) => el.addEventListener('click', () => goto('#/playlist/' + el.dataset.id)));
      } catch (err) { grid.innerHTML = '<div class="error-box">' + esc(err.message) + '</div>'; }
    };
    target.querySelector('#plNewBtn').addEventListener('click', async () => {
      const input = target.querySelector('#plNewName');
      const name = input.value.trim();
      if (!name) { toast('Name your playlist first', 'err'); return; }
      try {
        const p = await api('/api/me/playlists', { method: 'POST', body: JSON.stringify({ name }) });
        toast('Playlist created', 'ok');
        load();
      } catch (err) { toast(err.message, 'err'); }
    });
    target.querySelector('#plNewName').addEventListener('keydown', (e) => { if (e.key === 'Enter') target.querySelector('#plNewBtn').click(); });
    load();
  }
  async function renderPlaylist(target, view, id) {
    target.innerHTML = '<div class="empty">Loading…</div>';
    let pl;
    try { pl = await api('/api/playlists/' + id); }
    catch (err) { target.innerHTML = '<div class="error-box">' + esc(err.message) + '</div>'; return; }
    const mine = state.user && (state.user.role === 'admin' || state.user.username === pl.owner);
    target.innerHTML = `<div class="page">
      <div class="page-head">
        <div style="flex:1"><h1>${esc(pl.name)}</h1><p>by ${esc(pl.owner)} · ${fmt(pl.items.length)} videos</p></div>
        ${pl.items.length ? `<button class="w-btn primary" id="playAll">PLAY ALL</button>` : ''}
        ${mine ? `<button class="w-btn" id="delPl">DELETE</button>` : ''}
      </div>
      <div class="grid" id="plDetailGrid"></div>
    </div>`;
    const grid = target.querySelector('#plDetailGrid');
    if (!pl.items.length) grid.innerHTML = '<div class="empty">This playlist is empty.</div>';
    else {
      grid.innerHTML = pl.items.map((v) => `<div class="card" data-id="${v.id}">
        <div class="thumb"><img src="${thumbUrl(v.id)}" alt="" loading="lazy" onerror="this.outerHTML=''"><span class="play-ic">▶</span><span class="age">${esc(v.ageRating)}</span></div>
        <div class="body"><h3>${esc(v.title)}</h3><div class="meta">${esc(v.genre)} · ${esc(v.publisher)}</div><div class="stats">${fmt(v.views)} views</div></div>
        ${mine ? `<button class="pl-remove" data-rm="${v.id}" style="position:absolute;top:34px;right:10px">remove</button>` : ''}
      </div>`).join('');
      grid.querySelectorAll('.card').forEach((el) => el.addEventListener('click', (e) => {
        if (e.target.closest('.pl-remove')) return;
        goto('#/watch/' + el.dataset.id);
      }));
      grid.querySelectorAll('.pl-remove').forEach((b) => b.addEventListener('click', async (e) => {
        const vId = e.target.dataset.rm;
        if (!confirm('Remove from this playlist?')) return;
        try {
          await api('/api/playlists/' + id + '/items/' + vId, { method: 'DELETE' });
          e.target.closest('.card').remove();
          toast('Removed', 'ok');
        } catch (err) { toast(err.message, 'err'); }
      }));
    }
    const playAll = target.querySelector('#playAll');
    if (playAll) playAll.addEventListener('click', () => goto('#/watch/' + pl.items[0].id));
    const delPl = target.querySelector('#delPl');
    if (delPl) delPl.addEventListener('click', async () => {
      if (!confirm('Delete this playlist?')) return;
      try { await api('/api/me/playlists/' + id, { method: 'DELETE' }); toast('Playlist deleted', 'ok'); goto('#/playlists'); }
      catch (err) { toast(err.message, 'err'); }
    });
  }

  /* ---------------- UPLOAD ---------------- */
  async function renderUpload(target) {
    if (!state.user || !['creator', 'admin'].includes(role())) {
      target.innerHTML = `<div class="page"><div class="empty">
        <h1 style="font-family:var(--font-display);margin-bottom:10px">Creators only</h1>
        <p style="margin-bottom:12px">Creator accounts are provisioned by an administrator.</p>
        <button class="w-btn primary" id="upSignIn">SIGN IN</button>
      </div></div>`;
      target.querySelector('#upSignIn').addEventListener('click', () => openAuth('login'));
      return;
    }
    let genres = state.meta.genres;
    if (!genres.length) { try { state.meta = await api('/api/meta'); genres = state.meta.genres; } catch { } }
    target.innerHTML = `<div class="page">
      <div class="page-head"><h1>UPLOAD</h1><p>Ship your work to the feed — every frame counts.</p></div>
      <div class="form-card">
        <div class="dropzone" id="dz"><div class="big">▲</div><b>Drop video here or click to browse</b><div style="font-size:12px;margin-top:6px">mp4/webm · up to 2 GB</div><input id="upFile" type="file" accept="video/*" style="display:none"></div>
        <label>Title <input id="upTitle" maxlength="120" required></label>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label style="flex:1;min-width:160px">Publisher <input id="upPublisher" maxlength="80" value="Vantage Studios"></label>
          <label style="flex:1;min-width:160px">Producer <input id="upProducer" maxlength="80"></label>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label style="flex:1;min-width:140px">Genre <select id="upGenre">${genres.map((g) => `<option>${esc(g)}</option>`).join('')}</select></label>
          <label style="flex:1;min-width:100px">Age rating <select id="upAge">${(state.meta.ageRatings || ['G', 'PG', 'PG-13', 'R']).map((a) => `<option>${esc(a)}</option>`).join('')}</select></label>
        </div>
        <div class="progressbar hidden" id="upBar"><div class="fill" style="width:0%"></div></div>
        <button class="w-btn primary" id="upGo" disabled>UPLOAD</button>
      </div>
    </div>`;
    const dz = target.querySelector('#dz');
    const fileInput = target.querySelector('#upFile');
    let file = null;
    dz.addEventListener('click', (e) => { if (e.target !== fileInput) fileInput.click(); });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); pick(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', () => pick(fileInput.files[0]));
    function pick(f) {
      if (!f || !f.type.startsWith('video/')) { toast('Choose a video file', 'err'); return; }
      file = f;
      dz.innerHTML = `<div class="big">✓</div><b>${esc(f.name)}</b><div style="font-size:12px;margin-top:6px">${(f.size / 1048576).toFixed(1)} MB</div>`;
      target.querySelector('#upGo').disabled = false;
    }
    target.querySelector('#upGo').addEventListener('click', () => {
      const title = target.querySelector('#upTitle').value.trim();
      if (!title) { toast('Give it a title', 'err'); return; }
      if (!file) { toast('Pick a file first', 'err'); return; }
      const params = new URLSearchParams({
        title, publisher: target.querySelector('#upPublisher').value.trim() || 'Vantage Studios',
        producer: target.querySelector('#upProducer').value.trim() || state.user.username,
        genre: target.querySelector('#upGenre').value, age: target.querySelector('#upAge').value,
        ext: (file.name.split('.').pop() || 'mp4').toLowerCase(),
      });
      const bar = target.querySelector('#upBar');
      bar.classList.remove('hidden');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/videos?' + params.toString());
      xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) target.querySelector('#upBar .fill').style.width = Math.round((e.loaded / e.total) * 100) + '%'; };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { toast('Uploaded — watch it fly', 'ok'); goto('#/mine'); }
        else { let msg = 'Upload failed'; try { msg = JSON.parse(xhr.responseText).error || msg; } catch { } toast(msg, 'err'); bar.classList.add('hidden'); }
      };
      xhr.onerror = () => { toast('Upload failed', 'err'); bar.classList.add('hidden'); };
      xhr.send(file);
    });
  }

  /* ---------------- MINE ---------------- */
  async function renderMine(target) {
    if (!state.user || !['creator', 'admin'].includes(role())) {
      target.innerHTML = `<div class="page"><div class="empty">
        <h1 style="font-family:var(--font-display);margin-bottom:10px">Creators only</h1>
        <button class="w-btn primary" id="mineSignIn">SIGN IN</button>
      </div></div>`;
      target.querySelector('#mineSignIn').addEventListener('click', () => openAuth('login'));
      return;
    }
    target.innerHTML = `<div class="page">
      <div class="page-head"><h1>MY VIDEOS</h1><p>Views, likes and comments — the analytics that matter.</p></div>
      <div class="mine-row" id="mineRows"></div>
    </div>`;
    const rows = target.querySelector('#mineRows');
    try {
      const list = await api('/api/me/videos');
      if (!list.length) { rows.innerHTML = '<div class="empty">Nothing uploaded yet — <a href="#/upload" style="color:var(--accent);font-weight:700">upload one</a>.</div>'; return; }
      const max = Math.max(1, ...list.map((v) => v.views));
      rows.innerHTML = list.map((v) => `<div class="mine-card" data-id="${v.id}">
        <div class="row">
          <div class="grow"><h3>${esc(v.title)}</h3><div class="stat">${esc(v.genre)} · ${esc(v.publisher)} · created ${ago(v.createdAt)} · ★ ${Number(v.avgRating || 0).toFixed(1)} (${fmt(v.ratingCount)})</div></div>
          <button class="w-btn" data-edit="${v.id}">EDIT</button>
          <button class="w-btn" data-del="${v.id}">DELETE</button>
        </div>
        <div class="bars">
          <div class="bar-col"><div class="lab"><span>Views</span><b>${fmt(v.views)}</b></div><div class="track"><div class="fill" style="width:${Math.round((v.views / max) * 100)}%"></div></div></div>
          <div class="bar-col"><div class="lab"><span>Likes</span><b>${fmt(v.likeCount)}</b></div><div class="track"><div class="fill" style="width:${Math.round((v.likeCount / Math.max(1, v.views)) * 100)}%"></div></div></div>
          <div class="bar-col"><div class="lab"><span>Comments</span><b>${fmt(v.commentCount)}</b></div><div class="track"><div class="fill" style="width:${Math.round((v.commentCount / Math.max(1, v.views)) * 100)}%"></div></div></div>
        </div>
      </div>`).join('');
      rows.querySelectorAll('.mine-card').forEach((el) => {
        el.querySelector('[data-edit]').addEventListener('click', () => openEditVideo(list.find((v) => v.id === Number(el.dataset.id)), () => render()));
        el.querySelector('[data-del]').addEventListener('click', async () => {
          const v = list.find((x) => x.id === Number(el.dataset.id));
          if (!confirm('Delete "' + v.title + '"? This cannot be undone.')) return;
          try { await api('/api/videos/' + v.id, { method: 'DELETE' }); toast('Deleted', 'ok'); render(); }
          catch (err) { toast(err.message, 'err'); }
        });
      });
    } catch (err) { rows.innerHTML = '<div class="error-box">' + esc(err.message) + '</div>'; }
  }

  /* ---------------- generic form modal ---------------- */
  function openFormModal(title, fields, submitLabel, onSubmit) {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `<div class="modal-card">
      <button class="modal-close">×</button>
      <h2 class="modal-title">${esc(title)}</h2>
      <form class="form-fields">${fields.map((f) => `<label>${esc(f.label)}${f.type === 'select'
        ? `<select name="${esc(f.name)}">${f.options.map((o) => `<option ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
        : `<input name="${esc(f.name)}" value="${esc(f.value || '')}" maxlength="${f.maxlength || 120}">`}</label>`).join('')}
      <button class="primary" type="submit">${esc(submitLabel)}</button></form>
    </div>`;
    back.addEventListener('click', (e) => { if (e.target === back || e.target.classList.contains('modal-close')) back.remove(); });
    back.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const vals = {};
      back.querySelectorAll('input, select').forEach((el) => { vals[el.name] = el.value.trim(); });
      try { await onSubmit(vals); back.remove(); } catch (err) { toast(err.message, 'err'); }
    });
    document.body.appendChild(back);
    back.querySelector('input, select') && back.querySelector('input, select').focus();
  }
  function openEditVideo(v, refresh) {
    openFormModal('Edit video', [
      { name: 'title', label: 'Title', value: v.title },
      { name: 'publisher', label: 'Publisher', value: v.publisher },
      { name: 'producer', label: 'Producer', value: v.producer },
      { name: 'genre', label: 'Genre', type: 'select', value: v.genre, options: state.meta.genres.length ? state.meta.genres : ['Wildlife', 'Scenic', 'Roads', 'Education', 'Other', 'Aerial'] },
    ], 'Save', async (vals) => {
      await api('/api/videos/' + v.id, { method: 'PATCH', body: JSON.stringify(vals) });
      toast('Saved', 'ok');
      refresh && refresh();
    });
  }

  /* ---------------- ADMIN ---------------- */
  async function renderAdmin(target) {
    if (role() !== 'admin') {
      target.innerHTML = `<div class="page"><div class="empty">
        <h1 style="font-family:var(--font-display);margin-bottom:10px">Admins only</h1>
        <button class="w-btn primary" id="adSignIn">SIGN IN</button>
      </div></div>`;
      target.querySelector('#adSignIn').addEventListener('click', () => openAuth('login'));
      return;
    }
    target.innerHTML = `<div class="page">
      <div class="page-head"><h1>ADMIN</h1><p>Platform pulse and creator provisioning.</p></div>
      <div class="stats-row" id="adStats"></div>
      <div class="admin-grid">
        <div class="form-card">
          <h3 style="letter-spacing:1px">PROVISION CREATOR</h3>
          <label>Username <input id="adU" maxlength="40"></label>
          <label>Email <input id="adE" type="email"></label>
          <label>Password <input id="adP" type="password" minlength="6"></label>
          <button class="w-btn primary" id="adCreate">CREATE CREATOR</button>
        </div>
        <div class="panel">
          <h3>CREATORS</h3>
          <table><thead><tr><th>ID</th><th>Username</th><th>Email</th><th></th></tr></thead><tbody id="adRows"></tbody></table>
        </div>
      </div>
    </div>`;
    const stats = target.querySelector('#adStats');
    const rows = target.querySelector('#adRows');
    const loadStats = async () => {
      try {
        const s = await api('/api/admin/stats');
        stats.innerHTML = [['Users', s.users], ['Videos', s.videos], ['Comments', s.comments]].map(([k, n]) => `<div class="stat-chip"><b>${n}</b><span>${k}</span></div>`).join('');
      } catch (err) { stats.innerHTML = '<div class="error-box">' + esc(err.message) + '</div>'; }
    };
    const loadCreators = async () => {
      try {
        const list = await api('/api/admin/creators');
        rows.innerHTML = list.length ? list.map((u) => `<tr><td>${u.id}</td><td>${esc(u.username)}</td><td>${esc(u.email)}</td><td><button class="mini-del" data-del="${u.id}" data-name="${esc(u.username)}">remove</button></td></tr>`).join('') : '<tr><td colspan="4" style="color:var(--ink-dim)">No creators yet.</td></tr>';
        rows.querySelectorAll('.mini-del').forEach((b) => b.addEventListener('click', async () => {
          if (!confirm('Remove creator "' + b.dataset.name + '"?')) return;
          try { await api('/api/admin/creators/' + b.dataset.del, { method: 'DELETE' }); toast('Creator removed', 'ok'); loadCreators(); loadStats(); }
          catch (err) { toast(err.message, 'err'); }
        }));
      } catch (err) { rows.innerHTML = '<tr><td colspan="4" class="error-box">' + esc(err.message) + '</td></tr>'; }
    };
    target.querySelector('#adCreate').addEventListener('click', async () => {
      const username = target.querySelector('#adU').value.trim();
      const email = target.querySelector('#adE').value.trim();
      const password = target.querySelector('#adP').value;
      try {
        await api('/api/admin/creators', { method: 'POST', body: JSON.stringify({ username, email, password }) });
        toast('Creator ' + username + ' provisioned', 'ok');
        target.querySelector('#adU').value = ''; target.querySelector('#adE').value = ''; target.querySelector('#adP').value = '';
        loadCreators(); loadStats();
      } catch (err) { toast(err.message, 'err'); }
    });
    loadStats(); loadCreators();
  }

  /* ---------------- ACCOUNT ---------------- */
  function renderAccount(target) {
    if (!state.user) {
      target.innerHTML = `<div class="page"><div class="empty" style="max-width:420px;margin:0 auto">
        <h1 style="font-family:var(--font-display);font-size:26px;margin-bottom:8px">Vantage, for you.</h1>
        <p style="margin-bottom:16px">Resume anywhere. Keep queues. Rate and comment.</p>
        <button class="w-btn primary" id="acSignIn" style="margin-right:8px">SIGN IN</button>
        <button class="w-btn" id="acSignUp">SIGN UP</button>
      </div></div>`;
      target.querySelector('#acSignIn').addEventListener('click', () => openAuth('login'));
      target.querySelector('#acSignUp').addEventListener('click', () => openAuth('register'));
      return;
    }
    const u = state.user;
    target.innerHTML = `<div class="page"><div style="max-width:560px;margin:0 auto">
      <div class="panel" style="margin-bottom:14px">
        <h3>ACCOUNT</h3>
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <div style="width:52px;height:52px;border-radius:16px;background:var(--accent);color:#0a0c10;display:grid;place-items:center;font-size:22px;font-weight:800">${esc((u.username[0] || 'V').toUpperCase())}</div>
          <div><b style="font-size:18px">${esc(u.username)}</b><div class="stat" style="color:var(--ink-dim);font-size:13px">${esc(u.role)} account${u.role === 'admin' ? ' · full access' : ''}</div></div>
          <button class="w-btn" style="margin-left:auto" id="acOut">SIGN OUT</button>
        </div>
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(180px,1fr))">
        <div class="pl-card" data-goto="#/playlists"><div class="cover">▤</div><h3>My playlists</h3></div>
        ${['creator', 'admin'].includes(u.role) ? `<div class="pl-card" data-goto="#/upload"><div class="cover">▲</div><h3>Upload</h3></div>
        <div class="pl-card" data-goto="#/mine"><div class="cover">📊</div><h3>Analytics</h3></div>` : ''}
        ${u.role === 'admin' ? `<div class="pl-card" data-goto="#/admin"><div class="cover">◈</div><h3>Admin</h3></div>` : ''}
        <div class="pl-card" data-goto="#/explore"><div class="cover">◎</div><h3>Explore</h3></div>
      </div>
    </div></div>`;
    target.querySelector('#acOut').addEventListener('click', () => logout());
    target.querySelectorAll('.pl-card').forEach((el) => el.addEventListener('click', () => goto(el.dataset.goto)));
  }

  /* ---------------- keyboard + global clicks ---------------- */
  document.addEventListener('keydown', (e) => {
    const modals = ['#authModal', '#plModal'];
    const anyModal = modals.some((s) => !$(s).classList.contains('hidden')) || !!document.querySelector('.modal-backdrop:not(.hidden)') || !$('#sheetBackdrop').classList.contains('hidden');
    if (e.key === 'Escape') {
      if (!$('#sheetBackdrop').classList.contains('hidden')) { closeSheet(); return; }
      if (!$('#authModal').classList.contains('hidden')) { closeAuth(); return; }
      if (!$('#plModal').classList.contains('hidden')) { closePlModal(); return; }
      const fm = document.querySelector('.modal-backdrop');
      if (fm) { fm.remove(); return; }
      if (currentView() === 'watch') goto('#/feed');
      return;
    }
    if (anyModal) {
      if (e.key === 'Enter' && document.activeElement && document.activeElement.tagName === 'BUTTON') e.target.click();
      return;
    }
    const v = currentView();
    if (v === 'watch') {
      const vid = window.__vtVideo;
      if (!vid) return;
      if (e.key === ' ') { e.preventDefault(); vid.paused ? vid.play().catch(() => {}) : vid.pause(); }
      else if (e.key === 'ArrowLeft') { vid.currentTime = Math.max(0, vid.currentTime - 5); }
      else if (e.key === 'ArrowRight') { vid.currentTime = Math.min(vid.duration || vid.currentTime, vid.currentTime + 5); }
    } else if (v === 'feed' && feedEl) {
      const h = feedEl.clientHeight;
      if (e.key === 'ArrowDown') { e.preventDefault(); feedEl.scrollTo({ top: (feedIndex + 1) * h, behavior: 'smooth' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); feedEl.scrollTo({ top: Math.max(0, (feedIndex - 1) * h), behavior: 'smooth' }); }
    }
  });

  document.addEventListener('click', (e) => {
    const backdrop = e.target.closest('.modal-backdrop, .sheet-backdrop');
    if (backdrop && e.target === backdrop) {
      if (backdrop.id === 'sheetBackdrop') closeSheet();
      else backdrop.remove();
    }
  });

  /* ---------------- bindings ---------------- */
  $('#authClose').addEventListener('click', closeAuth);
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#plClose').addEventListener('click', closePlModal);
  $('#plCreate').addEventListener('click', async () => {
    const name = $('#plName').value.trim();
    if (!name) { toast('Name your playlist', 'err'); return; }
    try {
      const p = await api('/api/me/playlists', { method: 'POST', body: JSON.stringify({ name }) });
      if (plVideoId) await api('/api/playlists/' + p.id + '/items', { method: 'POST', body: JSON.stringify({ videoId: plVideoId }) });
      toast('Playlist created & added', 'ok');
      closePlModal();
      if (currentView() === 'playlists') render();
    } catch (err) { toast(err.message, 'err'); }
  });
  $$('.tab').forEach((t) => t.addEventListener('click', () => openAuth(t.dataset.tab)));
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#authUsername').value.trim();
    const password = $('#authPassword').value;
    const email = $('#authEmail').value.trim();
    const btn = $('#authSubmit');
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const ep = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = authMode === 'login' ? { username, password } : { username, email, password };
      const res = await api(ep, { method: 'POST', body: JSON.stringify(body) });
      saveSession(res.token, res.user);
      closeAuth();
      toast('Welcome, ' + res.user.username, 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = authMode === 'login' ? 'Sign in' : 'Create account';
    }
  });
  document.querySelector('.brand').addEventListener('click', () => goto('#/feed'));
  $('#bottomNav').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    if (a.dataset.nav === 'playlists' && !state.user) { e.preventDefault(); openAuth('login'); }
  });
  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => { if (document.hidden && window.__vtVideo) saveProgress(window.__vtVideo); });

  renderChrome();
  render();
})();
