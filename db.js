const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const DATA_DIR = process.env.VANTAGE_DATA || path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
for (const d of [DATA_DIR, UPLOADS_DIR, THUMBS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const db = new DatabaseSync(path.join(DATA_DIR, 'vantage.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'consumer',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  publisher TEXT NOT NULL,
  producer TEXT NOT NULL,
  genre TEXT NOT NULL,
  age_rating TEXT NOT NULL DEFAULT 'G',
  filename TEXT NOT NULL UNIQUE,
  duration INTEGER,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  views INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ratings (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stars INTEGER NOT NULL,
  PRIMARY KEY (video_id, user_id)
);
CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, video_id)
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (playlist_id, video_id)
);
`);

function videoRow(v) {
  if (!v) return null;
  return {
    id: v.id,
    title: v.title,
    publisher: v.publisher,
    producer: v.producer,
    genre: v.genre,
    ageRating: v.age_rating,
    duration: v.duration,
    views: v.views,
    ratingCount: v.rating_count,
    ratingSum: v.rating_sum,
    avgRating: v.rating_count ? Math.round((v.rating_sum / v.rating_count) * 10) / 10 : 0,
    commentCount: v.comment_count,
    uploadedById: v.uploaded_by,
    uploader: v.uploader || null,
    createdAt: v.created_at,
  };
}

module.exports = { db, DATA_DIR, UPLOADS_DIR, THUMBS_DIR, videoRow };