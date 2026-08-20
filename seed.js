const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { db, UPLOADS_DIR, THUMBS_DIR } = require('./db');
const { hashPassword } = require('./auth');

const STOCK_DIR = path.resolve(process.env.STOCK_DIR || path.join(__dirname, 'stock'));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function ensureUser(username, email, role, password) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(username, email, hashPassword(password), role);
  return info.lastInsertRowid;
}

function mp4Duration(file) {
  try {
    const b = fs.readFileSync(file);
    const i = b.indexOf(Buffer.from('mvhd'));
    if (i < 8) return null;
    const ver = b[i + 8];
    const ts = ver === 1 ? b.readUInt32BE(i + 20) : b.readUInt32BE(i + 12);
    const dur = ver === 1 ? Number(b.readBigUInt64BE(i + 24)) : b.readUInt32BE(i + 16);
    if (!ts || !dur) return null;
    return Math.round(dur / ts);
  } catch {
    return null;
  }
}

function probeDuration(file) {
  try {
    const out = execFileSync(FFMPEG.replace('ffmpeg', 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    const d = Math.round(Number(out.trim()));
    if (Number.isFinite(d) && d > 0) return d;
  } catch {
    try {
      const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
      const d = Math.round(Number(out.trim()));
      if (Number.isFinite(d) && d > 0) return d;
    } catch { }
  }
  return mp4Duration(file);
}

function makeThumb(videoFile, name) {
  const out = path.join(THUMBS_DIR, `${name}.jpg`);
  if (fs.existsSync(out)) return true;
  try {
    execFileSync(FFMPEG, ['-y', '-i', videoFile, '-ss', '1', '-frames:v', '1', '-q:v', '4', out], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const CLIPS = [
  { file: 'dog.mp4', title: 'Tail Chasers', publisher: 'Paw Print Studio', producer: 'Liam Okafor', genre: 'Wildlife', age: 'G', by: 'creator1' },
  { file: 'code.mp4', title: 'Syntax Sunrise', publisher: 'ByteHouse', producer: 'Priya Nair', genre: 'Education', age: 'G', by: 'creator1' },
  { file: 'drive.mp4', title: 'Midnight Merge', publisher: 'Motion Routes', producer: 'Kenji Sato', genre: 'Roads', age: 'PG', by: 'creator1' },
  { file: 'apple.mp4', title: 'Gravity Apples', publisher: 'Fruitoscope', producer: 'Nadia Haddad', genre: 'Other', age: 'G', by: 'creator1' },
  { file: 'bears.mp4', title: 'Salmon Summit', publisher: 'Safari Reel', producer: 'Tom Whitfield', genre: 'Wildlife', age: 'G', by: 'creator1' },
  { file: 'carpark.mp4', title: 'Top Deck Drift', publisher: 'Aerial Tribe', producer: 'Lucia Romano', genre: 'Aerial', age: 'PG', by: 'creator1' },
  { file: 'nature.mp4', title: 'Cloudline', publisher: 'High Altitude', producer: 'Maren Johansson', genre: 'Scenic', age: 'G', by: 'creator1' },
  { file: 'roads.mp4', title: 'Asphalt Rivers', publisher: 'Motion Routes', producer: 'Kenji Sato', genre: 'Roads', age: 'G', by: 'creator1' },
  { file: 'animals.mp4', title: 'Prairie Pulse', publisher: 'Safari Reel', producer: 'Tom Whitfield', genre: 'Wildlife', age: 'G', by: 'creator1' },
];

const COMMENTS = [
  'This one is a keeper, absolutely gorgeous.',
  'The framing here is unreal.',
  'Bookmarked this instantly.',
];

const users = {
  admin: ensureUser('admin', 'admin@vantage.app', 'admin', 'admin123'),
  creator1: ensureUser('creator1', 'creator1@vantage.app', 'creator', 'creator123'),
  viewer1: ensureUser('viewer1', 'viewer1@vantage.app', 'consumer', 'viewer123'),
};

db.prepare("DELETE FROM ratings WHERE user_id IN (SELECT id FROM users WHERE username NOT IN ('admin','creator1','viewer1'))").run();
db.prepare("UPDATE videos SET uploaded_by = ? WHERE uploaded_by IN (SELECT id FROM users WHERE username NOT IN ('admin','creator1','viewer1'))").run(users.creator1);
db.prepare("UPDATE comments SET user_id = ? WHERE user_id IN (SELECT id FROM users WHERE username NOT IN ('admin','creator1','viewer1'))").run(users.viewer1);
db.prepare("UPDATE playlists SET user_id = ? WHERE user_id IN (SELECT id FROM users WHERE username NOT IN ('admin','creator1','viewer1'))").run(users.viewer1);
db.prepare("DELETE FROM users WHERE username NOT IN ('admin','creator1','viewer1')").run();

let seeded = 0, skipped = 0, failed = 0;

for (const c of CLIPS) {
  try {
    const existing = db.prepare('SELECT id FROM videos WHERE title = ?').get(c.title);
    if (existing) { skipped++; continue; }
    const src = path.join(STOCK_DIR, c.file);
    if (!fs.existsSync(src)) { console.warn(`SKIP ${c.title}: stock missing ${c.file}`); failed++; continue; }
    const out = path.join(UPLOADS_DIR, c.file);
    fs.copyFileSync(src, out);
    const duration = probeDuration(src);
    const owner = users[c.by] || users.admin;
    const info = db.prepare('INSERT INTO videos (title, publisher, producer, genre, age_rating, filename, duration, uploaded_by, views) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.title, c.publisher, c.producer, c.genre, c.age, c.file, duration, owner, 120 + (Math.random() * 900 | 0));
    const vid = Number(info.lastInsertRowid);
    for (const body of COMMENTS) {
      db.prepare('INSERT INTO comments (video_id, user_id, body) VALUES (?, ?, ?)').run(vid, users.viewer1, body);
    }
    db.prepare('UPDATE videos SET comment_count = ? WHERE id = ?').run(3, vid);
    if (vid % 2 === 0) {
      db.prepare('INSERT INTO ratings (video_id, user_id, stars) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(vid, users.viewer1, 5);
      db.prepare('UPDATE videos SET rating_count = 1, rating_sum = 5 WHERE id = ?').run(vid);
    }
    makeThumb(out, c.file.replace(/\.[^.]+$/, ''));
    seeded++;
  } catch (e) {
    console.warn(`FAIL ${c.title}: ${e.message}`);
    failed++;
  }
}

console.log(`Vantage seed complete: ${seeded} created, ${skipped} existing, ${failed} failed.`);
console.log('Logins: admin/admin123 · creator1/creator123 · viewer1/viewer123');