const fs = require('node:fs');
const path = require('node:path');
const { THUMBS_DIR, UPLOADS_DIR } = require('./db');

function parseIntSafe(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function streamVideo(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;
  const mime = 'video/mp4';

  if (!range) {
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m || (m[1] === '' && m[2] === '')) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    res.end();
    return;
  }
  let start = m[1] === '' ? total - parseIntSafe(m[2]) : parseIntSafe(m[1]);
  let end = m[2] === '' ? total - 1 : Math.min(parseIntSafe(m[2]), total - 1);
  if (start === null) start = 0;
  if (end === null || end < start) end = total - 1;
  if (start >= total) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    res.end();
    return;
  }

  res.writeHead(206, {
    'Content-Type': mime,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

const PLACEHOLDER = (seed, label) => {
  const colors = [['#0d1410', '#c9f73c'], ['#0f0d16', '#8b7bff'], ['#10141c', '#4fc3f7'], ['#16100a', '#ffb454']];
  const [bg, fg] = colors[(seed || 0) % colors.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${bg}"/><circle cx="560" cy="60" r="120" fill="${fg}" opacity="0.08"/><text x="32" y="200" font-family="Arial Black,Arial" font-size="34" font-weight="900" fill="${fg}" letter-spacing="4">${label || 'VANTAGE'}</text></svg>`;
  return Buffer.from(svg);
};

function sendThumb(req, res, video, id) {
  if (video && video.filename) {
    const jpg = path.join(THUMBS_DIR, `${video.filename.replace(/\.[^.]+$/, '')}.jpg`);
    if (fs.existsSync(jpg)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(jpg).pipe(res);
      return;
    }
  }
  const buf = PLACEHOLDER(id, (video && video.title) || 'VANTAGE');
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
  res.end(buf);
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

module.exports = { streamVideo, sendThumb, fileExists, UPLOADS_DIR, THUMBS_DIR };