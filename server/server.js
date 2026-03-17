const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, '../public', req.url === '/' ? 'host.html' : req.url);
  const ext = path.extname(filePath);
  const contentTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const ADVANTAGE_SECS = 10;

let gameState = {
  buzzer: null,
  blocked: false,
  mode: 'all',
  advantageTeam: null,
  advantageTimer: null,
  players: {},
  host: null,
};

function broadcast(data, excludeId) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      if (excludeId && client._id === excludeId) return;
      client.send(msg);
    }
  });
}

function sendToClient(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function getPlayersList() {
  return Object.values(gameState.players).map(p => ({ id: p.id, name: p.name, team: p.team }));
}

function clearAdvantageTimer() {
  if (gameState.advantageTimer) { clearTimeout(gameState.advantageTimer); gameState.advantageTimer = null; }
}

function doReset() {
  clearAdvantageTimer();
  gameState.blocked = false;
  gameState.buzzer = null;
  gameState.mode = 'all';
  gameState.advantageTeam = null;
  broadcast({ type: 'reset' });
}

wss.on('connection', (ws) => {
  ws._id = Math.random().toString(36).substr(2, 9);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join_host':
        gameState.host = ws;
        ws._role = 'host';
        sendToClient(ws, {
          type: 'state',
          buzzer: gameState.buzzer,
          blocked: gameState.blocked,
          mode: gameState.mode,
          advantageTeam: gameState.advantageTeam,
          players: getPlayersList()
        });
        break;

      case 'join_player': {
        const { name, team } = msg;
        if (!name || !team) return;
        gameState.players[ws._id] = { id: ws._id, name, team, ws };
        ws._role = 'player';
        ws._name = name;
        ws._team = team;
        sendToClient(ws, {
          type: 'joined', id: ws._id, name, team,
          blocked: gameState.blocked,
          mode: gameState.mode,
          advantageTeam: gameState.advantageTeam,
          buzzer: gameState.buzzer
        });
        const pl = getPlayersList();
        broadcast({ type: 'players_update', players: pl });
        if (gameState.host) sendToClient(gameState.host, { type: 'players_update', players: pl });
        break;
      }

      case 'buzz': {
        const player = gameState.players[ws._id];
        if (!player) return;
        if (gameState.mode === 'advantage') {
          if (player.team !== gameState.advantageTeam) { sendToClient(ws, { type: 'buzz_denied' }); return; }
        } else {
          if (gameState.blocked) { sendToClient(ws, { type: 'buzz_denied' }); return; }
        }
        clearAdvantageTimer();
        gameState.blocked = true;
        gameState.mode = 'all';
        gameState.advantageTeam = null;
        gameState.buzzer = { id: ws._id, name: player.name, team: player.team, time: Date.now() };
        broadcast({ type: 'buzz_event', buzzer: gameState.buzzer });
        break;
      }

      case 'reset':
        if (ws._role !== 'host') return;
        doReset();
        break;

      case 'advantage': {
        if (ws._role !== 'host') return;
        if (!gameState.buzzer) return;
        const buzzerTeam = gameState.buzzer.team;
        const rivalTeam = buzzerTeam === 'A' ? 'B' : 'A';
        clearAdvantageTimer();
        gameState.mode = 'advantage';
        gameState.advantageTeam = rivalTeam;
        gameState.blocked = false;
        gameState.buzzer = null;
        broadcast({ type: 'advantage_start', advantageTeam: rivalTeam, blockedTeam: buzzerTeam, seconds: ADVANTAGE_SECS });
        gameState.advantageTimer = setTimeout(() => {
          gameState.mode = 'all';
          gameState.advantageTeam = null;
          gameState.blocked = false;
          broadcast({ type: 'advantage_end' });
        }, ADVANTAGE_SECS * 1000);
        break;
      }

      case 'get_players':
        sendToClient(ws, { type: 'players_update', players: getPlayersList() });
        break;

      case 'kick': {        if (ws._role !== 'host') return;
        const { playerId } = msg;
        const target = gameState.players[playerId];
        if (!target) return;
        sendToClient(target.ws, { type: 'kicked' });
        target.ws.close();
        delete gameState.players[playerId];
        const pl2 = getPlayersList();
        broadcast({ type: 'players_update', players: pl2 });
        if (gameState.host) sendToClient(gameState.host, { type: 'players_update', players: pl2 });
        if (gameState.buzzer && gameState.buzzer.id === playerId) doReset();
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws._role === 'player') {
      delete gameState.players[ws._id];
      const pl = getPlayersList();
      broadcast({ type: 'players_update', players: pl });
      if (gameState.host) sendToClient(gameState.host, { type: 'players_update', players: pl });
      if (gameState.buzzer && gameState.buzzer.id === ws._id) doReset();
    }
  });
});

server.listen(PORT, () => { console.log('حروف server running on port ' + PORT); });
