const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'huroof-secret-change-in-prod';
const TOKEN_EXPIRY = 30 * 24 * 60 * 60;

function hashPw(pw) { return bcrypt.hashSync(pw, 10); }
function checkPw(pw, hash) { return bcrypt.compareSync(pw, hash); }
function makeToken(userId) { return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY }); }
function verifyToken(token) { try { return jwt.verify(token, JWT_SECRET); } catch { return null; } }

function getUserFromToken(token) {
  if (!token) return null;
  const p = verifyToken(token);
  if (!p) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(p.userId) || null;
}

// ─── Email/Password ───────────────────────────────────────────
function registerEmail(email, password, name) {
  email = email.toLowerCase().trim();
  if (!email.includes('@')) return { error: 'بريد إلكتروني غير صحيح' };
  if (password.length < 6) return { error: 'كلمة المرور 6 أحرف على الأقل' };
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return { error: 'البريد مستخدم مسبقاً' };
  const r = db.prepare('INSERT INTO users (email, password_hash, name, auth_method) VALUES (?,?,?,?)').run(email, hashPw(password), name || email.split('@')[0], 'email');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  return { user, token: makeToken(user.id) };
}

function loginEmail(email, password) {
  email = email.toLowerCase().trim();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !user.password_hash) return { error: 'البريد أو كلمة المرور غير صحيحة' };
  if (!checkPw(password, user.password_hash)) return { error: 'البريد أو كلمة المرور غير صحيحة' };
  return { user, token: makeToken(user.id) };
}

// ─── Phone / OTP ─────────────────────────────────────────────
function generateOTP(phone) {
  phone = phone.replace(/\s/g, '');
  if (!phone.startsWith('+')) phone = '+966' + phone.replace(/^0/, '');
  // Delete old codes
  db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(phone);
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = Math.floor(Date.now() / 1000) + 300; // 5 min
  db.prepare('INSERT INTO otp_codes (phone, code, expires_at) VALUES (?,?,?)').run(phone, code, expires);
  return { phone, code }; // In prod: send via SMS provider
}

function verifyOTP(phone, code) {
  phone = phone.replace(/\s/g, '');
  if (!phone.startsWith('+')) phone = '+966' + phone.replace(/^0/, '');
  const row = db.prepare('SELECT * FROM otp_codes WHERE phone = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(phone);
  if (!row) return { error: 'أرسل رمز التحقق أولاً' };
  if (row.expires_at < Math.floor(Date.now() / 1000)) return { error: 'انتهت صلاحية الرمز، أعد الإرسال' };
  if (row.code !== code) return { error: 'رمز التحقق غير صحيح' };
  db.prepare('UPDATE otp_codes SET used = 1 WHERE id = ?').run(row.id);
  // Get or create user
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) {
    const r = db.prepare('INSERT INTO users (phone, name, auth_method) VALUES (?,?,?)').run(phone, phone, 'phone');
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  }
  return { user, token: makeToken(user.id) };
}

// ─── Google OAuth ─────────────────────────────────────────────
async function loginGoogle(googleToken) {
  const fetch = require('node-fetch');
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${googleToken}`);
  const data = await res.json();
  if (data.error || !data.sub) return { error: 'فشل التحقق من Google' };
  if (data.aud !== process.env.GOOGLE_CLIENT_ID) return { error: 'Client ID غير صحيح' };

  let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(data.sub);
  if (!user) {
    // Check if email exists (link accounts)
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(data.email);
    if (user) {
      db.prepare('UPDATE users SET google_id = ?, avatar = ? WHERE id = ?').run(data.sub, data.picture, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    } else {
      const r = db.prepare('INSERT INTO users (email, google_id, name, avatar, auth_method) VALUES (?,?,?,?,?)').run(data.email, data.sub, data.name, data.picture, 'google');
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    }
  }
  return { user, token: makeToken(user.id) };
}

// ─── Session control ─────────────────────────────────────────
function canStartSession(user) {
  // Pro plan
  if (user.plan === 'pro') {
    if (user.subscription_end && user.subscription_end < Math.floor(Date.now() / 1000)) {
      db.prepare('UPDATE users SET plan=?, sessions_limit=2 WHERE id=?').run('free', user.id);
      return { allowed: false, reason: 'انتهى اشتراكك، جدّده للمتابعة' };
    }
    return { allowed: true };
  }
  // Session credits (3 ريال/جلسة)
  if (user.session_credits > 0) return { allowed: true, useCredit: true };
  // Free plan
  if (user.sessions_used < user.sessions_limit) return { allowed: true, useFree: true };
  return { allowed: false, reason: 'استنفدت جلساتك المجانية، اشترِ جلسة أو اشترك' };
}

function consumeSession(userId, type) {
  if (type === 'useCredit') db.prepare('UPDATE users SET session_credits = session_credits - 1 WHERE id = ?').run(userId);
  else if (type === 'useFree') db.prepare('UPDATE users SET sessions_used = sessions_used + 1 WHERE id = ?').run(userId);
}

module.exports = { registerEmail, loginEmail, generateOTP, verifyOTP, loginGoogle, getUserFromToken, makeToken, canStartSession, consumeSession };
