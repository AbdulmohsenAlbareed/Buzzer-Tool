const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const ADVANTAGE_SECS = 10;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let filePath = path.join(__dirname, 'public', url.pathname === '/' ? 'host.html' : url.pathname);
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = {};

function getRoom(id) {
  if (!rooms[id]) rooms[id] = {
    hosts: {},   // عدة هوستات في نفس الوقت
    players: {}, displays: {},
    buzzer: null, blocked: false,
    mode: 'all', advantageTeam: null, advantageTimer: null
  };
  return rooms[id];
}

function bcast(room, data, skip) {
  const msg = JSON.stringify(data);
  Object.values(room.hosts).forEach(h => { if (h.readyState === 1 && h._id !== skip) h.send(msg); });
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

wss.on('connection', (ws) => {
  ws._id = Math.random().toString(36).substr(2, 9);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join_host': {
        const roomId = msg.roomId || `room_${ws._id}`;
        const room = getRoom(roomId);
        room.hosts[ws._id] = ws;
        ws._roomId = roomId; ws._role = 'host';
        send(ws, {
          type: 'state', roomId,
          buzzer: room.buzzer, blocked: room.blocked,
          mode: room.mode, advantageTeam: room.advantageTeam,
          players: playersList(room)
        });
        break;
      }

      case 'join_display': {
        const room = rooms[msg.roomId];
        if (!room) { send(ws, { type: 'error', message: 'الغرفة غير موجودة' }); return; }
        room.displays[ws._id] = ws; ws._role = 'display'; ws._roomId = msg.roomId;
        send(ws, { type: 'state', buzzer: room.buzzer, blocked: room.blocked, mode: room.mode, advantageTeam: room.advantageTeam });
        break;
      }

      case 'join_player': {
        const { name, team, roomId } = msg;
        if (!name || !team) return;
        if (!roomId) { send(ws, { type: 'error', message: 'رابط الغرفة غير صحيح — تأكد من الرابط' }); return; }
        const room = rooms[roomId];
        if (!room) { send(ws, { type: 'error', message: 'الغرفة غير موجودة — تأكد من الرابط' }); return; }
        if (Object.keys(room.hosts).length === 0) { send(ws, { type: 'error', message: 'الهوست لم يبدأ الجلسة بعد — انتظر قليلاً' }); return; }
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
        const room = ws._roomId ? rooms[ws._roomId] : null; if (!room) return;
        const player = room.players[ws._id]; if (!player) return;
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
    if (ws._role === 'host') {
      delete room.hosts[ws._id];
    } else if (ws._role === 'display') { delete room.displays[ws._id]; }
    else if (ws._role === 'player') {
      delete room.players[ws._id];
      bcast(room, { type: 'players_update', players: playersList(room) });
      if (room.buzzer?.id === ws._id) doReset(room);
    }
  });
});

server.listen(PORT, () => console.log('أداة الزر — مجاني — port ' + PORT));
