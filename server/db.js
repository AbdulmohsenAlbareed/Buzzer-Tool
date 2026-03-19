const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/huroof.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    phone TEXT UNIQUE,
    password_hash TEXT,
    google_id TEXT UNIQUE,
    name TEXT,
    avatar TEXT,
    auth_method TEXT DEFAULT 'email',   -- 'email' | 'phone' | 'google'
    created_at INTEGER DEFAULT (unixepoch()),

    -- subscription
    plan TEXT DEFAULT 'free',           -- 'free' | 'session' | 'pro'
    sessions_used INTEGER DEFAULT 0,    -- جلسات المجاني المستهلكة
    sessions_limit INTEGER DEFAULT 1,   -- 1 مجاناً
    session_credits INTEGER DEFAULT 0,  -- جلسات مدفوعة (3 ريال/جلسة)
    subscription_end INTEGER,           -- pro plan expiry
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    stripe_payment_id TEXT,
    amount INTEGER,
    currency TEXT DEFAULT 'sar',
    plan TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
`);

module.exports = db;
