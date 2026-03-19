const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cookie = require('cookie');
const { registerEmail, loginEmail, generateOTP, verifyOTP, loginGoogle, getUserFromToken, canStartSession, consumeSession } = require('./auth');
const { createCheckout, handleCallback } = require('./payments');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const ADVANTAGE_SECS = 10;

// ─── HTTP ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const p = url.pathname;

  function json(code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
  function setCookieAndJson(token, data) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` });
    res.end(JSON.stringify(data));
  }
  function getUser() {
    const cookies = cookie.parse(req.headers.cookie || '');
    return getUserFromToken(cookies.token || (req.headers.authorization || '').replace('Bearer ', ''));
  }
  async function body() {
    return new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } }); });
  }

  // POST /api/register
  if (p === '/api/register' && req.method === 'POST') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (rateLimit(ip + '_reg', 5, 60000)) return json(429, { error: 'كثير من المحاولات، انتظر دقيقة' });
    const { email, password, name } = await body();
    const result = registerEmail(email, password, name);
    if (result.error) return json(400, { error: result.error });
    setCookieAndJson(result.token, { ok: true, name: result.user.name });
    return;
  }

  // POST /api/login
  if (p === '/api/login' && req.method === 'POST') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (rateLimit(ip + '_login', 8, 60000)) return json(429, { error: 'كثير من المحاولات، انتظر دقيقة' });
    const { email, password } = await body();
    const result = loginEmail(email, password);
    if (result.error) return json(400, { error: result.error });
    setCookieAndJson(result.token, { ok: true, name: result.user.name });
    return;
  }

  // POST /api/otp/send
  if (p === '/api/otp/send' && req.method === 'POST') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (rateLimit(ip + '_otp', 3, 60000)) return json(429, { error: 'كثير من المحاولات، انتظر دقيقة' });
    const { phone } = await body();
    if (!phone) return json(400, { error: 'أدخل رقم الجوال' });
    const result = generateOTP(phone);
    // In PRODUCTION: send SMS via Unifonic/Msegat/Twilio
    // For dev: return code directly (remove in production!)
    const isDev = !process.env.SMS_API_KEY;
    json(200, { ok: true, phone: result.phone, ...(isDev ? { dev_code: result.code } : {}) });
    return;
  }

  // POST /api/otp/verify
  if (p === '/api/otp/verify' && req.method === 'POST') {
    const { phone, code } = await body();
    const result = verifyOTP(phone, code);
    if (result.error) return json(400, { error: result.error });
    setCookieAndJson(result.token, { ok: true, name: result.user.name });
    return;
  }

  // POST /api/google
  if (p === '/api/google' && req.method === 'POST') {
    const { token } = await body();
    try {
      const result = await loginGoogle(token);
      if (result.error) return json(400, { error: result.error });
      setCookieAndJson(result.token, { ok: true, name: result.user.name });
    } catch(e) { json(500, { error: 'خطأ في Google: ' + e.message }); }
    return;
  }

  // POST /api/logout
  if (p === '/api/logout' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'token=; Path=/; Max-Age=0' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /api/me
  if (p === '/api/me' && req.method === 'GET') {
    const user = getUser();
    if (!user) return json(401, { error: 'غير مسجل' });
    json(200, { id: user.id, name: user.name, email: user.email, phone: user.phone, avatar: user.avatar, plan: user.plan, sessions_used: user.sessions_used, sessions_limit: user.sessions_limit, session_credits: user.session_credits, subscription_end: user.subscription_end });
    return;
  }

  // POST /api/checkout/:type  (MyFatoorah)
  if (p.startsWith('/api/checkout/') && req.method === 'POST') {
    const user = getUser();
    if (!user) return json(401, { error: 'سجل دخولك أولاً' });
    const type = p.split('/')[3]; // 'session' or 'pro'
    try {
      const result = await createCheckout(user, type);
      json(200, { url: result.url });
    } catch(e) { json(500, { error: e.message }); }
    return;
  }

  // GET /api/mf-callback  (MyFatoorah redirect بعد الدفع)
  if (p === '/api/mf-callback' && req.method === 'GET') {
    const paymentId = url.searchParams.get('paymentId');
    const userId    = url.searchParams.get('userId');
    const plan      = url.searchParams.get('plan');
    try {
      await handleCallback({ paymentId, userId, plan });
      res.writeHead(302, { Location: '/host.html?payment=success&plan=' + plan });
      res.end();
    } catch(e) {
      res.writeHead(302, { Location: '/pricing.html?payment=failed&reason=' + encodeURIComponent(e.message) });
      res.end();
    }
    return;
  }
  }

  // GET /api/admin/stats
  if (p === '/api/admin/stats' && req.method === 'GET') {
    if (req.headers['x-admin-secret'] !== (process.env.ADMIN_SECRET || 'admin123')) return json(401, { error: 'غير مصرح' });
    const users = db.prepare('SELECT id, email, phone, name, plan, sessions_used, session_credits, created_at, subscription_end FROM users ORDER BY created_at DESC').all();
    const payments = db.prepare('SELECT p.*, u.name user_name FROM payments p LEFT JOIN users u ON p.user_id=u.id ORDER BY p.created_at DESC LIMIT 100').all();
    const revenue = db.prepare("SELECT SUM(amount) total FROM payments WHERE created_at > unixepoch('now','-30 days')").get();
    json(200, { users, payments, total_users: users.length, pro_users: users.filter(u=>u.plan==='pro').length, monthly_revenue: Math.round((revenue.total||0)/100) });
    return;
  }

  // Static files
  let filePath = path.join(__dirname, '../public', p === '/' ? 'host.html' : p);
  const ext = path.extname(filePath);
  const types = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

// ─── WebSocket ────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });
const rooms = {};

// ─── Rate Limiter (بسيط) ─────────────────────────────────────
const rateLimits = {}; // { ip: { count, resetAt } }
function rateLimit(ip, max = 10, windowMs = 60000) {
  const now = Date.now();
  if (!rateLimits[ip] || rateLimits[ip].resetAt < now) {
    rateLimits[ip] = { count: 0, resetAt: now + windowMs };
  }
  rateLimits[ip].count++;
  return rateLimits[ip].count > max;
}
// نظّف كل 5 دقائق
setInterval(() => {
  const now = Date.now();
  Object.keys(rateLimits).forEach(k => { if (rateLimits[k].resetAt < now) delete rateLimits[k]; });
}, 300000);

// ─── Session Timer ────────────────────────────────────────────
const FREE_SESSION_MS    = 15 * 60 * 1000;  // مجاني: 15 دقيقة
const CREDIT_SESSION_MS  = 60 * 60 * 1000;  // جلسة 3 ريال: ساعة كاملة
const WARN_BEFORE_MS     =  5 * 60 * 1000;  // تحذير قبل 5 دقائق

function startSessionTimer(ws, room) {
  if (room.sessionTimer)   { clearTimeout(room.sessionTimer);   room.sessionTimer   = null; }
  if (room.sessionWarning) { clearTimeout(room.sessionWarning); room.sessionWarning = null; }

  // Pro = بدون حد
  if (ws._user?.plan === 'pro') return;

  // حدد مدة الجلسة حسب نوعها
  const sessionDuration = ws._user?._sessionType === 'useCredit'
    ? CREDIT_SESSION_MS
    : FREE_SESSION_MS;

  // لو في جلسة سابقة — أكمل من حيث وقفت
  const now = Date.now();
  if (!room.sessionEnd) {
    room.sessionEnd = now + sessionDuration;
  }

  const remaining = room.sessionEnd - now;

  // إذا انتهت الجلسة أثناء الانقطاع
  if (remaining <= 0) {
    send(ws, { type: 'session_expired' });
    bcast(room, { type: 'host_session_ended' });
    Object.values(room.players).forEach(p => { send(p.ws, { type: 'session_ended' }); p.ws.close(); });
    room.players = {}; room.host = null; ws.close();
    return;
  }

  // تحذير 5 دقائق قبل الانتهاء
  const warnIn = remaining - WARN_BEFORE_MS;
  if (warnIn > 0) {
    room.sessionWarning = setTimeout(() => {
      send(ws, { type: 'session_warning', minutesLeft: 5 });
    }, warnIn);
  } else {
    // أقل من 5 دقائق متبقية — أرسل التحذير فوراً
    send(ws, { type: 'session_warning', minutesLeft: Math.ceil(remaining / 60000) });
  }

  // انتهاء الجلسة
  room.sessionTimer = setTimeout(() => {
    send(ws, { type: 'session_expired' });
    bcast(room, { type: 'host_session_ended' });
    Object.values(room.players).forEach(p => { send(p.ws, { type: 'session_ended' }); p.ws.close(); });
    room.players = {}; room.host = null; ws.close();
  }, remaining);
}

function getRoom(id) {
  if (!rooms[id]) rooms[id] = {
    host: null, players: {}, displays: {},
    buzzer: null, blocked: false,
    mode: 'all', advantageTeam: null, advantageTimer: null,
    sessionTimer: null, sessionWarning: null, sessionStart: null, sessionEnd: null
  };
  return rooms[id];
}
function bcast(room, data, skip) {
  const msg = JSON.stringify(data);
  if (room.host?.readyState === 1 && room.host._id !== skip) room.host.send(msg);
  Object.values(room.players).forEach(p => { if (p.ws.readyState === 1 && p.ws._id !== skip) p.ws.send(msg); });
  Object.values(room.displays).forEach(d => { if (d.readyState === 1 && d._id !== skip) d.send(msg); });
}
function send(ws, data) { if (ws?.readyState === 1) ws.send(JSON.stringify(data)); }
function playersList(room) { return Object.values(room.players).map(p => ({ id: p.id, name: p.name, team: p.team })); }
function doReset(room) {
  if (room.advantageTimer) { clearTimeout(room.advantageTimer); room.advantageTimer = null; }
  room.blocked = false; room.buzzer = null; room.mode = 'all'; room.advantageTeam = null;
  bcast(room, { type: 'reset' });
}

wss.on('connection', (ws, req) => {
  ws._id = Math.random().toString(36).substr(2, 9);
  const cookies = cookie.parse(req.headers.cookie || '');
  ws._user = getUserFromToken(cookies.token);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join_host': {
        if (!ws._user) { send(ws, { type: 'auth_required' }); return; }
        // Re-fetch fresh user data
        ws._user = db.prepare('SELECT * FROM users WHERE id = ?').get(ws._user.id);
        const check = canStartSession(ws._user);
        if (!check.allowed) { send(ws, { type: 'session_blocked', reason: check.reason }); return; }
        // خزّن نوع الجلسة قبل الاستهلاك
        ws._user._sessionType = check.useFree ? 'useFree' : check.useCredit ? 'useCredit' : null;
        consumeSession(ws._user.id, ws._user._sessionType);
        // Re-fetch after consume
        ws._user = db.prepare('SELECT * FROM users WHERE id = ?').get(ws._user.id);
        const roomId = `room_${ws._user.id}`;
        const room = getRoom(roomId);
        room.host = ws; ws._roomId = roomId; ws._role = 'host';

        // ابدأ عداد الجلسة (15 دقيقة للمجاني، لا حد للـ Pro)
        startSessionTimer(ws, room);

        send(ws, {
          type: 'state', buzzer: room.buzzer, blocked: room.blocked, mode: room.mode,
          advantageTeam: room.advantageTeam, players: playersList(room),
          roomId,
          sessionEnd: room.sessionEnd,   // وقت انتهاء الجلسة (null = Pro)
          user: { id: ws._user.id, name: ws._user.name, plan: ws._user.plan, sessions_used: ws._user.sessions_used, sessions_limit: ws._user.sessions_limit, session_credits: ws._user.session_credits }
        });
        break;
      }

      case 'join_display': {
        const { roomId } = msg;
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) { send(ws, { type: 'error', message: 'الغرفة غير موجودة' }); return; }
        room.displays[ws._id] = ws;
        ws._role = 'display'; ws._roomId = roomId;
        send(ws, {
          type: 'state', buzzer: room.buzzer, blocked: room.blocked,
          mode: room.mode, advantageTeam: room.advantageTeam
        });
        break;
      }
        const { name, team, roomId } = msg;
        if (!name || !team || !roomId) return;
        const room = rooms[roomId];
        if (!room || !room.host) { send(ws, { type: 'error', message: 'الغرفة غير موجودة' }); return; }
        if (Object.keys(room.players).length >= MAX_PLAYERS) { send(ws, { type: 'error', message: 'الغرفة ممتلئة (٤ لاعبين)' }); return; }
        room.players[ws._id] = { id: ws._id, name, team, ws };
        ws._role = 'player'; ws._roomId = roomId;
        send(ws, { type: 'joined', id: ws._id, name, team, blocked: room.blocked, mode: room.mode, advantageTeam: room.advantageTeam, buzzer: room.buzzer });
        bcast(room, { type: 'players_update', players: playersList(room) });
        break;
      }

      case 'get_players': {
        const room = msg.roomId ? rooms[msg.roomId] : null;
        if (room) send(ws, { type: 'players_update', players: playersList(room) });
        break;
      }

      case 'buzz': {
        const room = ws._roomId ? rooms[ws._roomId] : null;
        if (!room) return;
        const player = room.players[ws._id];
        if (!player) return;
        if (room.mode === 'advantage') {
          if (player.team !== room.advantageTeam) { send(ws, { type: 'buzz_denied' }); return; }
        } else {
          if (room.blocked) { send(ws, { type: 'buzz_denied' }); return; }
        }
        if (room.advantageTimer) { clearTimeout(room.advantageTimer); room.advantageTimer = null; }
        room.blocked = true; room.mode = 'all'; room.advantageTeam = null;
        room.buzzer = { id: ws._id, name: player.name, team: player.team, time: Date.now() };
        bcast(room, { type: 'buzz_event', buzzer: room.buzzer });
        break;
      }

      case 'reset': {
        if (ws._role !== 'host') return;
        const room = rooms[ws._roomId]; if (room) doReset(room);
        break;
      }

      case 'advantage': {
        if (ws._role !== 'host') return;
        const room = rooms[ws._roomId]; if (!room?.buzzer) return;
        const rival = room.buzzer.team === 'A' ? 'B' : 'A';
        const blocked = room.buzzer.team;
        if (room.advantageTimer) { clearTimeout(room.advantageTimer); room.advantageTimer = null; }
        room.mode = 'advantage'; room.advantageTeam = rival; room.blocked = false; room.buzzer = null;
        bcast(room, { type: 'advantage_start', advantageTeam: rival, blockedTeam: blocked, seconds: ADVANTAGE_SECS });
        room.advantageTimer = setTimeout(() => {
          room.mode = 'all'; room.advantageTeam = null; room.blocked = false;
          bcast(room, { type: 'advantage_end' });
        }, ADVANTAGE_SECS * 1000);
        break;
      }

      case 'kick': {
        if (ws._role !== 'host') return;
        const room = rooms[ws._roomId]; if (!room) return;
        const t = room.players[msg.playerId]; if (!t) return;
        send(t.ws, { type: 'kicked' }); t.ws.close();
        delete room.players[msg.playerId];
        bcast(room, { type: 'players_update', players: playersList(room) });
        if (room.buzzer?.id === msg.playerId) doReset(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = ws._roomId ? rooms[ws._roomId] : null; if (!room) return;
    if (ws._role === 'host') { room.host = null; }
    else if (ws._role === 'display') { delete room.displays[ws._id]; }
    else if (ws._role === 'player') {
      delete room.players[ws._id];
      bcast(room, { type: 'players_update', players: playersList(room) });
      if (room.buzzer?.id === ws._id) doReset(room);
    }
  });
});

server.listen(PORT, () => console.log('أداة الزر on port ' + PORT));
