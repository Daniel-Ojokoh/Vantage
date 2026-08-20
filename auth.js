const crypto = require('node:crypto');
const { db } = require('./db');

const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test);
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.userId ? payload : null;
  } catch {
    return null;
  }
}

function publicUser(u) {
  return u ? { id: u.id, username: u.username, email: u.email, role: u.role } : null;
}

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function currentUser(req) {
  return verifyToken(bearer(req));
}

function requireAuth(req, res, next) {
  const payload = currentUser(req);
  if (!payload) return sendJson(res, 401, { error: 'Authentication required' });
  req.user = payload;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return sendJson(res, 401, { error: 'Authentication required' });
    if (!roles.includes(req.user.role)) return sendJson(res, 403, { error: 'Not authorized for this action' });
    next();
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      chunks.push(c);
      if (size > 2_000_000) { req.destroy(); resolve(null); }
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function getOrCreateUserSession() {
  return null;
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, publicUser, bearer, currentUser, requireAuth, requireRole, sendJson, readJson, getOrCreateUserSession };