// ============================================================
//  联机 1v1 单挑服务端
//  运行方式:
//    1. npm install ws
//    2. node server.js
//    3. 浏览器打开 http://<电脑IP>:8080
// ============================================================

const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 2;

// ------------------------------------------------------------
//  HTTP 服务器（提供静态文件）
// ------------------------------------------------------------
const server = http.createServer((req, res) => {
  let urlPath = req.url === '/' ? '/index.html' : req.url;
  const safePath = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(__dirname, safePath);

  // 支持跨域
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 处理 OPTIONS 请求
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 处理 PUT 请求（保存地图配置）
  if (req.method === 'PUT' && urlPath === '/maps.json') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        JSON.parse(body); // 验证 JSON 格式
        fs.writeFile(filePath, body, (err) => {
          if (err) {
            res.writeHead(500);
            res.end('保存失败');
          } else {
            res.writeHead(200);
            res.end('保存成功');
          }
        });
      } catch (e) {
        res.writeHead(400);
        res.end('无效的 JSON 格式');
      }
    });
    return;
  }

  // 处理 GET 请求（静态文件）
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ------------------------------------------------------------
//  WebSocket 游戏服务
// ------------------------------------------------------------
const wss = new WebSocketServer({ server });

// 游戏房间（最多 2 人）
let players = []; // { ws, id, name, ready, pos, yaw, pitch, health, armor, weapon, ammo, reloading, kills, alive }
let matchStarted = false;
let gameStartTime = 0;

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(msg, exceptId = null) {
  for (const p of players) {
    if (p.id === exceptId) continue;
    send(p.ws, msg);
  }
}

function genId() {
  return 'p_' + Math.random().toString(36).slice(2, 9);
}

function getPlayerPublicState(p) {
  return {
    id: p.id,
    name: p.name,
    pos: p.pos,
    yaw: p.yaw,
    pitch: p.pitch,
    health: p.health,
    maxHealth: p.maxHealth,
    armor: p.armor,
    maxArmor: p.maxArmor,
    weapon: p.weapon,
    ammo: p.ammo,
    reloading: p.reloading,
    kills: p.kills,
    deaths: p.deaths,
    alive: p.alive
  };
}

function resetMatch() {
  for (const p of players) {
    p.pos = p.id === players[0].id
      ? { x: 15, y: 1.7, z: 15 }
      : { x: -15, y: 1.7, z: -15 };
    p.yaw = p.id === players[0].id ? Math.PI * 0.75 : Math.PI * (-0.25);
    p.pitch = 0;
    p.health = 100;
    p.maxHealth = 100;
    p.armor = 50;
    p.maxArmor = 50;
    p.weapon = 'rifle';
    p.ammo = 30;
    p.reloading = false;
    p.alive = true;
    p.kills = p.kills || 0;
    p.deaths = p.deaths || 0;
    p.hits = p.hits || 0;
    p.damageDealt = p.damageDealt || 0;
    p.posLockUntil = Date.now() + 800;
  }
  matchStarted = true;
  gameStartTime = Date.now();
}

function resetStats() {
  for (const p of players) {
    p.kills = 0;
    p.deaths = 0;
    p.hits = 0;
    p.damageDealt = 0;
  }
}

function checkMatchEnd() {
  const alive = players.filter(p => p.alive);
  if (players.length >= 2 && alive.length <= 1) {
    // 比赛结束
    const winner = alive[0];
    if (winner) {
      winner.kills = (winner.kills || 0) + 1;
    }
    broadcast({
      type: 'match_end',
      winner: winner ? winner.id : 'draw',
      winnerName: winner ? winner.name : '平局',
      players: players.map(p => getPlayerPublicState(p))
    });
    matchStarted = false;
    // 3 秒后自动开始下一局
    setTimeout(() => {
      if (players.length >= 2) {
        resetMatch();
        broadcast({
          type: 'match_start',
          startTime: Date.now(),
          players: players.map(p => getPlayerPublicState(p))
        });
      }
    }, 3000);
  }
}

wss.on('connection', (ws) => {
  const id = genId();
  const name = '玩家 ' + (players.length + 1);

  // 超出最大人数
  if (players.length >= MAX_PLAYERS) {
    send(ws, { type: 'server_full' });
    ws.close();
    return;
  }

  const newPlayer = {
    ws,
    id,
    name,
    pos: { x: 0, y: 1.7, z: 0 },
    yaw: 0,
    pitch: 0,
    health: 100,
    maxHealth: 100,
    armor: 50,
    maxArmor: 50,
    weapon: 'rifle',
    ammo: 30,
    reloading: false,
    alive: true,
    kills: 0,
    deaths: 0,
    hits: 0,
    damageDealt: 0,
    ready: false,
    cheat: { godMode: false, damageMult: 1, healthMult: 1 }
  };

  players.push(newPlayer);

  console.log(`[连接] ${id} (${name}) 已连接，当前: ${players.length}/${MAX_PLAYERS}`);

  // 告知自己 ID
  send(ws, {
    type: 'welcome',
    id,
    name,
    slot: players.length,
    matchStarted
  });

  // 告知其他玩家有新人加入
  broadcast({
    type: 'player_join',
    player: { id, name, pos: newPlayer.pos, health: newPlayer.health, maxHealth: newPlayer.maxHealth, armor: newPlayer.armor, maxArmor: newPlayer.maxArmor, alive: true }
  }, id);

  // 告知当前玩家现有队友列表
  send(ws, {
    type: 'players_list',
    players: players
      .filter(p => p.id !== id)
      .map(p => ({ id: p.id, name: p.name, pos: p.pos, health: p.health, maxHealth: p.maxHealth, armor: p.armor, maxArmor: p.maxArmor, alive: p.alive, kills: p.kills }))
  });

  // 如果已经满员，通知可以开始
  if (players.length === MAX_PLAYERS) {
    broadcast({ type: 'room_full' });
    // 2 秒后自动开始第一局
    setTimeout(() => {
      if (players.length === MAX_PLAYERS) {
        resetStats();
        resetMatch();
        broadcast({
          type: 'match_start',
          startTime: Date.now(),
          players: players.map(p => getPlayerPublicState(p))
        });
        console.log('[比赛] 1v1 比赛开始');
      }
    }, 2000);
  }

  // ------------------------------------------------------------
  //  消息处理
  // ------------------------------------------------------------
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) { return; }

    const player = players.find(p => p.id === id);
    if (!player) return;

    switch (msg.type) {

      // 玩家状态（位置、朝向） - 高频更新
      case 'player_state':
        if (!msg.state) break;
        const posLocked = player.posLockUntil && Date.now() < player.posLockUntil;
        if (msg.state.pos && !posLocked) player.pos = msg.state.pos;
        if (typeof msg.state.yaw === 'number') player.yaw = msg.state.yaw;
        if (typeof msg.state.pitch === 'number') player.pitch = msg.state.pitch;
        if (msg.state.weapon) player.weapon = msg.state.weapon;
        if (typeof msg.state.ammo === 'number') player.ammo = msg.state.ammo;
        if (typeof msg.state.reloading === 'boolean') player.reloading = msg.state.reloading;
        // 转发给其他玩家
        broadcast({
          type: 'player_state',
          id,
          state: {
            pos: player.pos,
            yaw: player.yaw,
            pitch: player.pitch,
            weapon: player.weapon,
            ammo: player.ammo,
            reloading: player.reloading
          }
        }, id);
        break;

      // 开火（仅通知视觉，不做伤害判定）
      case 'shoot':
        broadcast({ type: 'shoot', id, weapon: msg.weapon }, id);
        break;

      // 命中（包含伤害信息）
      case 'hit': {
        if (!matchStarted || !player.alive) break;
        const target = players.find(p => p.id === msg.targetId);
        if (!target || target.id === player.id) break;
        if (!target.alive) break;

        let damage = Math.max(0, msg.damage || 0);

        // 作弊倍率（服务端也处理）
        if (player.cheat) {
          damage *= (player.cheat.damageMult || 1);
        }
        if (target.cheat && target.cheat.godMode) {
          damage = 0;
        }
        damage = Math.round(damage);

        if (damage > 0) {
          // 先扣护甲（65% 吸收）
          let remaining = damage;
          if (target.armor > 0) {
            const absorbed = Math.min(target.armor, remaining * 0.65);
            target.armor -= absorbed;
            remaining -= absorbed;
          }
          target.health -= remaining;
          target.health = Math.max(0, target.health);
          player.hits = (player.hits || 0) + 1;
          player.damageDealt = (player.damageDealt || 0) + damage;

          // 通知双方
          send(player.ws, { type: 'hit_confirm', targetId: target.id, damage });
          broadcast({
            type: 'player_damaged',
            id: target.id,
            health: target.health,
            maxHealth: target.maxHealth,
            armor: target.armor,
            maxArmor: target.maxArmor,
            damaged: damage,
            attacker: player.id,
            attackerName: player.name,
            crit: !!msg.crit
          });

          // 死亡判定
          if (target.health <= 0 && target.alive) {
            target.alive = false;
            target.deaths = (target.deaths || 0) + 1;
            player.kills = (player.kills || 0) + 1;

            broadcast({
              type: 'player_died',
              id: target.id,
              killer: player.id,
              killerName: player.name,
              players: players.map(p => ({
                id: p.id,
                name: p.name,
                kills: p.kills,
                deaths: p.deaths
              }))
            });

            setTimeout(checkMatchEnd, 500);
          }
        }
        break;
      }

      // 玩家死亡（视觉）
      case 'death':
        broadcast({ type: 'death', id, by: msg.by }, id);
        break;

      // 聊天/提示
      case 'chat':
        broadcast({ type: 'chat', from: name, text: msg.text });
        break;

      // 作弊同步（仅同步到其他玩家的视觉显示）
      case 'cheat_sync':
        if (msg.cheat) player.cheat = { ...player.cheat, ...msg.cheat };
        break;

      // 手动重新开始（当有玩家请求时）
      case 'restart':
        if (players.length >= 2) {
          resetStats();
          resetMatch();
          broadcast({
            type: 'match_start',
            startTime: Date.now(),
            players: players.map(p => getPlayerPublicState(p))
          });
        }
        break;
    }
  });

  ws.on('close', () => {
    players = players.filter(p => p.id !== id);
    broadcast({ type: 'player_leave', id, name });
    console.log(`[断开] ${id} (${name}) 已离开，剩余: ${players.length}/${MAX_PLAYERS}`);

    if (players.length < 2) {
      matchStarted = false;
      broadcast({ type: 'match_pause', reason: '有玩家离开，等待新玩家加入...' });
    }
  });

  ws.on('error', (err) => {
    console.error(`[错误] ${id}:`, err.message);
  });
});

// 定期广播游戏状态（30Hz）
let tickCount = 0;
let lastTickTime = Date.now();
setInterval(() => {
  if (players.length < 2) return;
  tickCount++;
  const now = Date.now();
  if (now - lastTickTime >= 5000) {
    const tickRate = Math.round(tickCount / ((now - lastTickTime) / 1000));
    console.log(`[Tick] ${tickRate}/s  玩家: ${players.length}  比赛: ${matchStarted ? '进行中' : '等待'}`);
    tickCount = 0;
    lastTickTime = now;
  }
  broadcast({
    type: 'state_tick',
    time: Date.now() - gameStartTime,
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      pos: p.pos,
      yaw: p.yaw,
      pitch: p.pitch,
      health: p.health,
      maxHealth: p.maxHealth,
      armor: p.armor,
      maxArmor: p.maxArmor,
      weapon: p.weapon,
      ammo: p.ammo,
      reloading: p.reloading,
      alive: p.alive,
      kills: p.kills
    }))
  });
}, 33);

server.listen(PORT, '0.0.0.0', () => {
  console.log('======================================');
  console.log('  联机 1v1 服务器已启动');
  console.log(`  访问:  http://localhost:${PORT}`);
  console.log(`          http://局域网IP:${PORT}`);
  console.log(`          http://公网IP:${PORT}`);
  console.log('');
  console.log('  页面:  http 方式打开');
  console.log('  游戏:  WebSocket (ws://) 自动连接');
  console.log('');
  console.log('  公网:  路由器做端口转发 ' + PORT + ' → 本机 LAN IP');
  console.log('======================================');
});