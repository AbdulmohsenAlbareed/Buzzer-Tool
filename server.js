const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// HTTP server to serve static files
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, '../public', req.url === '/' ? 'host.html' : req.url);
  
  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
  };
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

// WebSocket server
const wss = new WebSocket.Server({ server });

// Game state
let gameState = {
  buzzer: null,        // { name, team, time }
  blocked: false,
  scores: { A: 0, B: 0 },
  players: {},         // { id: { name, team, ws } }
  host: null,
};

function broadcast(data, excludeId = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      if (excludeId && client._id === excludeId) return;
      client.send(msg);
    }
  });
}

function sendToClient(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getPlayersList() {
  return Object.values(gameState.players).map(p => ({
    id: p.id,
    name: p.name,
    team: p.team
  }));
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
          scores: gameState.scores,
          players: getPlayersList()
        });
        break;

      case 'join_player':
        const { name, team } = msg;
        if (!name || !team) return;
        
        gameState.players[ws._id] = { id: ws._id, name, team, ws };
        ws._role = 'player';
        ws._name = name;
        ws._team = team;

        sendToClient(ws, {
          type: 'joined',
          id: ws._id,
          name,
          team,
          blocked: gameState.blocked,
          buzzer: gameState.buzzer
        });

        broadcast({
          type: 'players_update',
          players: getPlayersList()
        });

        // Notify host
        if (gameState.host) {
          sendToClient(gameState.host, {
            type: 'players_update',
            players: getPlayersList()
          });
        }
        break;

      case 'buzz':
        if (gameState.blocked) {
          sendToClient(ws, { type: 'buzz_denied' });
          return;
        }
        
        const player = gameState.players[ws._id];
        if (!player) return;

        gameState.blocked = true;
        gameState.buzzer = {
          id: ws._id,
          name: player.name,
          team: player.team,
          time: Date.now()
        };

        broadcast({
          type: 'buzz_event',
          buzzer: gameState.buzzer
        });
        break;

      case 'reset':
        if (ws._role !== 'host') return;
        gameState.blocked = false;
        gameState.buzzer = null;
        broadcast({ type: 'reset' });
        break;

      case 'add_score':
        if (ws._role !== 'host') return;
        const { team: scoreTeam, points } = msg;
        if (scoreTeam === 'A' || scoreTeam === 'B') {
          gameState.scores[scoreTeam] += points;
          broadcast({
            type: 'score_update',
            scores: gameState.scores
          });
        }
        break;

      case 'reset_scores':
        if (ws._role !== 'host') return;
        gameState.scores = { A: 0, B: 0 };
        broadcast({ type: 'score_update', scores: gameState.scores });
        break;
    }
  });

  ws.on('close', () => {
    if (ws._role === 'player') {
      delete gameState.players[ws._id];
      broadcast({ type: 'players_update', players: getPlayersList() });
      if (gameState.host) {
        sendToClient(gameState.host, {
          type: 'players_update',
          players: getPlayersList()
        });
      }
      // If the buzzer disconnected, reset
      if (gameState.buzzer && gameState.buzzer.id === ws._id) {
        gameState.blocked = false;
        gameState.buzzer = null;
        broadcast({ type: 'reset' });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`حروف server running on port ${PORT}`);
});
