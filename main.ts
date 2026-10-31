// @ts-nocheck
/* 骗子酒馆 · NEON — Deno Deploy 版房间服务器
 * HTTP 静态页 + WebSocket 房间。无数据库、无外部依赖。
 * 入口文件：main.ts（依赖同目录的 deno-html.ts）
 */

import { INDEX_HTML } from './deno-html.ts';

const FAST = Deno.env.get('TEST_FAST') === '1';
const TURN_MS = FAST ? 2500 : 30000;
const REVEAL_AUTO_MS = FAST ? 1800 : 18000;
const ROULETTE_AUTO_MS = FAST ? 1800 : 12000;
const DISCONNECT_GRACE_MS = FAST ? 4000 : 90000;
const ROOM_EMPTY_MS = 5 * 60 * 1000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const RANKS = ['A', 'K', 'Q'];
const SUITS = ['♠', '♥', '♦', '♣'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ITEMS = ['peek', 'swap', 'blank'];

const rooms = new Map();
const conns = new Set();
let roomSeq = 0;
let cardSeq = 0;
let connSeq = 0;
const startedAt = Date.now();

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function randInt(max: number): number {
  if (!(max > 0)) return 0;
  const buf = new Uint32Array(1);
  const limit = Math.floor(4294967296 / max) * max;
  let value = 0;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return value % max;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i += 1) out += buf[i].toString(16).padStart(2, '0');
  return out;
}

function send(ws: any, payload: any) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) { /* socket died between checks */ }
}

function sendTo(player: any, payload: any) {
  if (!player || !player.connected) return;
  send(player.socket, payload);
}

function broadcast(room: any, payload: any, exceptId?: string) {
  room.players.forEach((player: any) => {
    if (player.id !== exceptId) sendTo(player, payload);
  });
}

function cleanName(value: any): string {
  const name = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10);
  return name || '无名酒客';
}

function cleanAvatar(value: any): string {
  return /^v[1-6]$/.test(String(value || '')) ? String(value) : 'v1';
}

function cleanText(value: any, max?: number): string {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 24);
}

function randomItem(): string {
  return ITEMS[randInt(ITEMS.length)];
}

function makeDeck(): any[] {
  const deck: any[] = [];
  RANKS.forEach((rank) => {
    for (let i = 0; i < 10; i += 1) {
      cardSeq += 1;
      deck.push({ id: `c${cardSeq}`, rank, suit: SUITS[cardSeq % 4] });
    }
  });
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function newCode(): string {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) {
      code += CODE_ALPHABET[randInt(CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  roomSeq += 1;
  return `X${String(roomSeq).padStart(3, '0').slice(-3)}`;
}

function newPlayer(room: any, name: any, avatar: any) {
  room.nextPid += 1;
  return {
    id: `p${room.nextPid}`,
    token: randomHex(18),
    name: cleanName(name),
    avatar: cleanAvatar(avatar),
    ready: false,
    connected: true,
    left: false,
    socket: null,
    hand: [],
    alive: true,
    chambers: 6,
    item: null,
    disconnectTimer: null,
    joinedAt: Date.now()
  };
}

function byId(room: any, id: string) {
  return room.players.find((player: any) => player.id === id) || null;
}

function connectedPlayers(room: any) {
  return room.players.filter((player: any) => player.connected && !player.left);
}

function alivePlayers(room: any) {
  return room.players.filter((player: any) => player.alive);
}

function publicRoom(room: any) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    maxPlayers: MAX_PLAYERS,
    players: room.players.map((player: any) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      ready: !!player.ready,
      connected: !!player.connected,
      left: !!player.left,
      isHost: player.id === room.hostId
    }))
  };
}

function sendRoom(room: any, target: any) {
  const payload = { t: 'room', room: publicRoom(room), selfId: target.id };
  sendTo(target, payload);
}

function broadcastRoom(room: any) {
  room.players.forEach((player: any) => {
    if (player.connected && !player.left) sendRoom(room, player);
  });
}

function ensureHost(room: any) {
  const current = room.players.find((player: any) => player.id === room.hostId && player.connected && !player.left);
  if (current) return;
  const next = room.players.find((player: any) => player.connected && !player.left);
  room.hostId = next ? next.id : null;
}

function chatEntry(player: any, text: string) {
  return { from: player.id, name: player.name, text, at: Date.now() };
}

function sendChatLog(room: any, player: any) {
  sendTo(player, { t: 'chatlog', items: room.chat.slice(-30) });
}

function pushLog(room: any, text: string, tone?: string) {
  const game = room.game;
  if (!game) return;
  game.log.push({ text, tone: tone || '', at: Date.now() });
  if (game.log.length > 90) game.log.shift();
}

function notice(room: any, text: string, tone?: string) {
  broadcast(room, { t: 'toast', text, tone: tone || '' });
}

/* ------------------------------------------------------------------ */
/* game lifecycle                                                      */
/* ------------------------------------------------------------------ */

function clearGameTimers(game: any) {
  if (!game) return;
  clearTimeout(game.turnTimer);
  clearTimeout(game.advanceTimer);
  game.turnTimer = null;
  game.advanceTimer = null;
}

function newGame(room: any) {
  clearGameTimers(room.game);
  room.players.forEach((player: any) => {
    player.alive = true;
    player.chambers = 6;
    player.hand = [];
    player.item = randomItem();
    player.ready = true;
    player.left = false;
  });
  const game = {
    id: `g${Date.now().toString(36)}${randomHex(3)}`,
    phase: 'turn',
    round: 0,
    target: RANKS[randInt(RANKS.length)],
    deck: [],
    pileCount: 0,
    lastPlay: null,
    turnIndex: 0,
    turnId: null,
    turnEndsAt: 0,
    log: [],
    reveal: null,
    roulette: null,
    over: null,
    stats: { challenges: 0, pulls: 0 },
    advanceToken: '',
    turnTimer: null,
    advanceTimer: null
  };
  room.game = game;
  room.status = 'playing';
  broadcastRoom(room);
  startRound(room, true);
}

function startRound(room: any, first: boolean) {
  const game = room.game;
  if (!game) return;
  clearGameTimers(game);
  game.round += 1;
  game.phase = 'turn';
  game.target = RANKS[randInt(RANKS.length)];
  game.deck = makeDeck();
  game.pileCount = 0;
  game.lastPlay = null;
  game.reveal = null;
  game.roulette = null;
  game.over = null;
  game.advanceToken = '';
  game.turnEndsAt = 0;

  room.players.forEach((player: any) => {
    player.hand = [];
    if (!player.alive) return;
    player.hand = game.deck.splice(0, 5);
    if (!player.item) player.item = randomItem();
  });

  const alive = room.players.filter((player: any) => player.alive);
  if (!alive.length) return;

  let index;
  if (first) {
    index = room.players.indexOf(alive[randInt(alive.length)]);
  } else {
    index = nextAliveIndex(room, Number.isInteger(game.turnIndex) ? game.turnIndex : 0);
  }
  pushLog(room, `第 ${game.round} 局开始，目标 ${game.target}`, 'hot');
  beginTurn(room, index);
}

function nextAliveIndex(room: any, from: number) {
  const total = room.players.length;
  for (let step = 1; step <= total; step += 1) {
    const index = (from + step) % total;
    if (room.players[index] && room.players[index].alive) return index;
  }
  return from;
}

function beginTurn(room: any, index: number) {
  const game = room.game;
  if (!game) return;
  clearTimeout(game.turnTimer);
  game.phase = 'turn';
  game.turnIndex = index;
  game.turnId = room.players[index] ? room.players[index].id : null;
  game.turnEndsAt = Date.now() + TURN_MS;
  const player = room.players[index];
  if (!player) return;
  broadcastState(room);
  const delay = player.connected ? TURN_MS + 60 : Math.min(TURN_MS, FAST ? 900 : 6000);
  game.turnTimer = setTimeout(() => {
    if (room.game !== game || game.phase !== 'turn' || game.turnId !== player.id) return;
    autoTurn(room, player);
  }, delay);
}

function autoTurn(room: any, player: any) {
  const game = room.game;
  if (!game || game.phase !== 'turn' || game.turnId !== player.id) return;
  pushLog(room, `${player.name} 超时，自动行动`, 'bad');
  if (game.lastPlay && (!player.hand.length || Math.random() < 0.5)) {
    resolveChallenge(room, player);
    return;
  }
  if (!player.hand.length) {
    if (game.lastPlay) resolveChallenge(room, player);
    return;
  }
  const pickCard = player.hand[Math.floor(Math.random() * player.hand.length)];
  resolvePlay(room, player, [pickCard.id]);
}

function resolvePlay(room: any, player: any, ids: string[]) {
  const game = room.game;
  if (!game || game.phase !== 'turn' || game.turnId !== player.id) return false;
  const unique = Array.from(new Set(ids));
  const cards = unique.map((id) => player.hand.find((card: any) => card.id === id)).filter(Boolean);
  if (!cards.length || cards.length > 3 || cards.length !== unique.length) return false;
  const idset = new Set(cards.map((card: any) => card.id));
  player.hand = player.hand.filter((card: any) => !idset.has(card.id));
  game.lastPlay = {
    playerId: player.id,
    cards: cards.map((card: any) => ({ ...card })),
    playId: `p${Date.now()}${Math.random().toString(16).slice(2, 7)}`
  };
  game.pileCount += cards.length;
  pushLog(room, `${player.name} 扣下 ${cards.length} 张，声称是 ${game.target}`);
  clearTimeout(game.turnTimer);
  beginTurn(room, nextAliveIndex(room, game.turnIndex));
  return true;
}

function resolveChallenge(room: any, challenger: any) {
  const game = room.game;
  if (!game || game.phase !== 'turn' || !game.lastPlay) return false;
  if (game.turnId !== challenger.id) return false;
  const accused = byId(room, game.lastPlay.playerId);
  if (!accused) return false;
  const cards = game.lastPlay.cards.map((card: any) => ({ ...card }));
  const liar = cards.some((card: any) => card.rank !== game.target);
  const loser = liar ? accused : challenger;
  clearTimeout(game.turnTimer);
  game.stats.challenges += 1;
  game.phase = 'reveal';
  game.turnEndsAt = 0;
  game.advanceToken = randomHex(6);
  game.reveal = {
    at: Date.now(),
    challengerId: challenger.id,
    challengerName: challenger.name,
    target: game.target,
    playerId: accused.id,
    playerName: accused.name,
    playerAvatar: accused.avatar,
    cards,
    liar,
    loserId: loser.id,
    loserName: loser.name,
    loserAvatar: loser.avatar,
    loserChambers: Math.max(1, loser.chambers)
  };
  pushLog(room, `${challenger.name} 质疑 ${accused.name}：${liar ? '抓到吹牛' : '质疑失败'}`, liar ? 'good' : 'bad');
  broadcastState(room);
  scheduleAdvance(room, REVEAL_AUTO_MS);
  return true;
}

function scheduleAdvance(room: any, delay: number) {
  const game = room.game;
  if (!game) return;
  clearTimeout(game.advanceTimer);
  game.advanceTimer = setTimeout(() => {
    if (room.game !== game) return;
    if (game.phase === 'reveal' || game.phase === 'roulette') resolveAdvance(room);
  }, delay);
}

function resolveAdvance(room: any) {
  const game = room.game;
  if (!game) return;
  if (game.phase === 'reveal' && game.reveal) {
    const loser = byId(room, game.reveal.loserId);
    if (!loser) return;
    clearTimeout(game.advanceTimer);
    const chambers = Math.max(1, loser.chambers);
    const fired = Math.random() < 1 / chambers;
    const saved = fired && loser.item === 'blank';
    game.phase = 'roulette';
    game.advanceToken = randomHex(6);
    game.roulette = {
      at: Date.now(),
      playerId: loser.id,
      playerName: loser.name,
      avatar: loser.avatar,
      chambers,
      fired,
      saved,
      isYou: false
    };
    game.stats.pulls += 1;
    pushLog(room, `${loser.name} 扣动扳机…`, 'hot');
    broadcastState(room);
    scheduleAdvance(room, ROULETTE_AUTO_MS);
    return;
  }
  if (game.phase !== 'roulette' || !game.roulette) return;
  const data = game.roulette;
  const loser = byId(room, data.playerId);
  if (!loser) return;
  clearTimeout(game.advanceTimer);
  loser.chambers = Math.max(0, loser.chambers - 1);
  if (data.fired && !data.saved) {
    loser.alive = false;
    loser.hand = [];
    pushLog(room, `${loser.name} 中弹出局`, 'bad');
  } else if (data.fired && data.saved) {
    loser.item = null;
    pushLog(room, `${loser.name} 的空膛卡挡下实弹，捡回一条命`, 'good');
  } else {
    pushLog(room, `${loser.name} 扣动扳机，空枪`, 'good');
  }
  if (loser.alive && loser.chambers === 0) {
    loser.chambers = 6;
    pushLog(room, `${loser.name} 弹巢打空，重新装填`, '');
  }
  game.advanceToken = '';
  game.reveal = null;
  game.roulette = null;
  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    endGame(room, alive[0] || loser);
    return;
  }
  startRound(room, false);
}

function endGame(room: any, winner: any) {
  const game = room.game;
  if (!game) return;
  clearGameTimers(game);
  game.phase = 'over';
  game.turnEndsAt = 0;
  game.advanceToken = '';
  game.reveal = null;
  game.roulette = null;
  game.over = {
    at: Date.now(),
    winnerId: winner.id,
    winnerName: winner.name,
    winnerAvatar: winner.avatar,
    rounds: game.round,
    challenges: game.stats.challenges,
    pulls: game.stats.pulls
  };
  pushLog(room, `${winner.name} 活到了最后`, 'good');
  broadcastState(room);
}

/* ------------------------------------------------------------------ */
/* state snapshots                                                     */
/* ------------------------------------------------------------------ */

function stateFor(room: any, viewer: any) {
  const game = room.game;
  if (!game) return null;
  const turnPlayer = game.phase === 'turn' ? byId(room, game.turnId) : null;
  return {
    source: 'online',
    mode: 'online',
    gameId: game.id,
    code: room.code,
    phase: game.phase,
    round: game.round,
    target: game.target,
    players: room.players.map((player: any) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      ai: false,
      alive: !!player.alive,
      chambers: player.chambers,
      cardCount: player.hand.length,
      isTurn: !!turnPlayer && turnPlayer.id === player.id,
      isHost: player.id === room.hostId,
      ready: !!player.ready,
      connected: !!player.connected,
      left: !!player.left,
      item: player.item
    })),
    selfId: viewer.id,
    hand: viewer.hand.map((card: any) => ({ id: card.id, rank: card.rank, suit: card.suit })),
    handHidden: false,
    item: viewer.item,
    lastPlay: game.lastPlay ? {
      playerId: game.lastPlay.playerId,
      name: (byId(room, game.lastPlay.playerId) || {}).name || '酒客',
      count: game.lastPlay.cards.length
    } : null,
    pileCount: game.pileCount,
    turnId: game.phase === 'turn' ? game.turnId : null,
    turnEndsAt: game.phase === 'turn' ? game.turnEndsAt : 0,
    turnMs: TURN_MS,
    advanceToken: game.advanceToken || '',
    log: game.log.slice(-30),
    reveal: game.reveal,
    roulette: game.roulette ? Object.assign({}, game.roulette, { isYou: game.roulette.playerId === viewer.id }) : null,
    over: game.over ? {
      at: game.over.at,
      winnerId: game.over.winnerId,
      winnerName: game.over.winnerName,
      winnerAvatar: game.over.winnerAvatar,
      rounds: game.over.rounds,
      challenges: game.over.challenges,
      pulls: game.over.pulls,
      isYou: game.over.winnerId === viewer.id
    } : null
  };
}

function broadcastState(room: any) {
  if (!room.game) return;
  room.players.forEach((player: any) => {
    if (!player.connected || player.left) return;
    const state = stateFor(room, player);
    if (state) sendTo(player, { t: 'state', state });
  });
}

/* ------------------------------------------------------------------ */
/* room membership                                                     */
/* ------------------------------------------------------------------ */

function createRoom(conn: any, msg: any) {
  if (conn.roomCode) {
    send(conn.ws, { t: 'error', code: 'ALREADY_IN_ROOM', message: '你已经在房间里了。' });
    return;
  }
  const code = newCode();
  const room = {
    code,
    status: 'lobby',
    hostId: null,
    players: [],
    game: null,
    chat: [],
    nextPid: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cleanupTimer: null
  };
  rooms.set(code, room);
  const player = newPlayer(room, msg.name, msg.avatar);
  player.socket = conn.ws;
  room.players.push(player);
  room.hostId = player.id;
  conn.roomCode = code;
  conn.playerId = player.id;
  attach(room, player, conn);
  send(conn.ws, { t: 'joined', code, playerId: player.id, token: player.token });
  sendRoom(room, player);
  sendChatLog(room, player);
  console.log(`[room ${code}] created by ${player.name} (${room.players.length})`);
}

function joinRoom(conn: any, msg: any) {
  if (conn.roomCode) {
    send(conn.ws, { t: 'error', code: 'ALREADY_IN_ROOM', message: '你已经在房间里了。' });
    return;
  }
  const code = cleanText(msg.code, 4).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const room = rooms.get(code);
  if (!room) {
    send(conn.ws, { t: 'error', code: 'ROOM_NOT_FOUND', message: '房间不存在，检查一下房间码。' });
    return;
  }
  if (room.status !== 'lobby') {
    send(conn.ws, { t: 'error', code: 'ROOM_STARTED', message: '这一桌已经开局了，等下一局。' });
    return;
  }
  const active = room.players.filter((player: any) => !player.left);
  if (active.length >= MAX_PLAYERS) {
    send(conn.ws, { t: 'error', code: 'ROOM_FULL', message: '房间满了，4 个人已经是上限。' });
    return;
  }
  const player = newPlayer(room, msg.name, msg.avatar);
  player.socket = conn.ws;
  room.players.push(player);
  conn.roomCode = code;
  conn.playerId = player.id;
  attach(room, player, conn);
  send(conn.ws, { t: 'joined', code, playerId: player.id, token: player.token });
  broadcastRoom(room);
  sendChatLog(room, player);
  notice(room, `${player.name} 进了酒馆`, 'good');
  console.log(`[room ${code}] ${player.name} joined (${active.length + 1})`);
}

function resumeRoom(conn: any, msg: any) {
  if (conn.roomCode) return;
  const code = cleanText(msg.code, 4).toUpperCase();
  const token = String(msg.token || '').slice(0, 128);
  const room = rooms.get(code);
  if (!room) {
    send(conn.ws, { t: 'error', code: 'RECONNECT_FAILED', message: '房间已经关闭，重新开一桌吧。' });
    return;
  }
  const player = room.players.find((item: any) => item.token && item.token === token && !item.left);
  if (!player) {
    send(conn.ws, { t: 'error', code: 'RECONNECT_FAILED', message: '这局已经接不上了，重新加入房间。' });
    return;
  }
  const old = player.socket;
  if (old && old !== conn.ws) {
    player.socket = null;
    try { old.close(4001, 'replaced'); } catch (err) { /* ignore */ }
  }
  clearTimeout(player.disconnectTimer);
  player.disconnectTimer = null;
  player.connected = true;
  player.socket = conn.ws;
  conn.roomCode = code;
  conn.playerId = player.id;
  attach(room, player, conn);
  send(conn.ws, { t: 'joined', code, playerId: player.id, token: player.token });
  sendRoom(room, player);
  sendChatLog(room, player);
  if (room.game) {
    const state = stateFor(room, player);
    if (state) send(conn.ws, { t: 'state', state });
  }
  broadcastRoom(room);
  notice(room, `${player.name} 回到了牌桌`, 'good');
  console.log(`[room ${code}] ${player.name} resumed`);
}

function attach(room: any, player: any, conn: any) {
  player.socket = conn.ws;
  player.connected = true;
  conn.roomCode = room.code;
  conn.playerId = player.id;
  room.updatedAt = Date.now();
}

function leaveRoom(conn: any, options?: any) {
  const opts = options || {};
  const room = rooms.get(conn.roomCode);
  const playerId = conn.playerId;
  conn.roomCode = null;
  conn.playerId = null;
  if (!room) return;
  const player = byId(room, playerId);
  if (!player) return;
  forfeitPlayer(room, player, opts.reason || 'left');
}

function forfeitPlayer(room: any, player: any, reason: string) {
  if (!room || !player || !room.players.includes(player)) return;
  clearTimeout(player.disconnectTimer);
  player.disconnectTimer = null;
  player.socket = null;
  player.connected = false;
  player.token = null;
  player.ready = false;

  if (room.status === 'lobby' || !room.game || room.game.phase === 'over') {
    room.players = room.players.filter((item: any) => item.id !== player.id);
  } else {
    player.left = true;
    const wasAlive = player.alive;
    player.alive = false;
    player.hand = [];
    if (wasAlive) pushLog(room, `${player.name} 离开了牌桌，视为出局`, 'bad');
    const game = room.game;
    if (game.phase === 'turn' && game.turnId === player.id) {
      const next = nextAliveFrom(room, player);
      if (alivePlayers(room).length <= 1) {
        endGame(room, alivePlayers(room)[0] || player);
      } else if (next != null) {
        beginTurn(room, next);
      }
    } else if (game.phase === 'turn') {
      const alive = alivePlayers(room);
      if (alive.length <= 1) endGame(room, alive[0] || player);
      else broadcastState(room);
    } else {
      broadcastState(room);
    }
  }

  ensureHost(room);
  broadcastRoom(room);
  if (room.game) broadcastState(room);
  notice(room, reason === 'timeout' ? `${player.name} 掉线太久，座位已收回` : `${player.name} 离开了酒馆`, 'warn');

  if (!room.players.length) {
    destroyRoom(room, 'empty');
    return;
  }
  if (!connectedPlayers(room).length) scheduleRoomCleanup(room, ROOM_EMPTY_MS);
  room.updatedAt = Date.now();
}

function nextAliveFrom(room: any, player: any) {
  const index = room.players.indexOf(player);
  if (index < 0) {
    const first = room.players.findIndex((item: any) => item.alive);
    return first >= 0 ? first : null;
  }
  const total = room.players.length;
  for (let step = 1; step <= total; step += 1) {
    const at = (index + step) % total;
    if (room.players[at] && room.players[at].alive) return at;
  }
  return null;
}

function scheduleRoomCleanup(room: any, ms: number) {
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    if (!connectedPlayers(room).length) destroyRoom(room, 'idle');
  }, ms);
}

function destroyRoom(room: any, reason: string) {
  if (!room || !rooms.has(room.code)) return;
  clearGameTimers(room.game);
  clearTimeout(room.cleanupTimer);
  room.players.forEach((player: any) => clearTimeout(player.disconnectTimer));
  rooms.delete(room.code);
  console.log(`[room ${room.code}] closed (${reason})`);
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

function handlePlay(conn: any, msg: any) {
  const room = rooms.get(conn.roomCode);
  if (!room || !room.game) return;
  const player = byId(room, conn.playerId);
  if (!player || player.left) return;
  const ids = Array.isArray(msg.cards) ? msg.cards.slice(0, 4).map((id: any) => String(id).slice(0, 32)) : [];
  const ok = resolvePlay(room, player, ids);
  if (!ok) send(conn.ws, { t: 'error', code: 'BAD_PLAY', message: '这张牌不在手里，或者不是你的回合。' });
}

function handleChallenge(conn: any) {
  const room = rooms.get(conn.roomCode);
  if (!room || !room.game) return;
  const player = byId(room, conn.playerId);
  if (!player || player.left) return;
  const ok = resolveChallenge(room, player);
  if (!ok) send(conn.ws, { t: 'error', code: 'BAD_CHALLENGE', message: '现在没有可质疑的牌。' });
}

function handleAdvance(conn: any, msg: any) {
  const room = rooms.get(conn.roomCode);
  if (!room || !room.game) return;
  const game = room.game;
  if (game.phase !== 'reveal' && game.phase !== 'roulette') return;
  if (!game.advanceToken || msg.token !== game.advanceToken) return;
  resolveAdvance(room);
}

function handleItem(conn: any, msg: any) {
  const room = rooms.get(conn.roomCode);
  if (!room || !room.game) return;
  const player = byId(room, conn.playerId);
  const game = room.game;
  if (!player || player.left) return;
  if (game.phase !== 'turn' || game.turnId !== player.id) {
    send(conn.ws, { t: 'error', code: 'NOT_YOUR_TURN', message: '还没轮到你用道具。' });
    return;
  }
  const item = String(msg.item || '');
  if (item !== player.item) {
    send(conn.ws, { t: 'error', code: 'NO_ITEM', message: '这个道具已经用掉了。' });
    return;
  }
  if (item === 'blank') {
    send(conn.ws, { t: 'error', code: 'PASSIVE_ITEM', message: '空膛是被动道具，中弹时自动生效。' });
    return;
  }
  if (item === 'peek') {
    if (!game.lastPlay) {
      send(conn.ws, { t: 'error', code: 'NO_PLAY', message: '还没有人出牌，没东西可看。' });
      return;
    }
    const cards = game.lastPlay.cards;
    const card = cards[Math.floor(Math.random() * cards.length)];
    const from = byId(room, game.lastPlay.playerId);
    player.item = null;
    pushLog(room, `${player.name} 用了眼线，瞟了一眼牌堆`);
    send(conn.ws, {
      t: 'peek',
      card: { id: card.id, rank: card.rank, suit: card.suit },
      fromName: from ? from.name : '对手',
      target: game.target
    });
    broadcastState(room);
    return;
  }
  if (item === 'swap') {
    const ids = Array.isArray(msg.cards) ? msg.cards.slice(0, 3).map((id: any) => String(id).slice(0, 32)) : [];
    const unique = Array.from(new Set(ids)).slice(0, 2);
    const chosen = unique.map((id) => player.hand.find((card: any) => card.id === id)).filter(Boolean);
    if (!chosen.length || chosen.length !== unique.length) {
      send(conn.ws, { t: 'error', code: 'BAD_SWAP', message: '选择 1–2 张手牌来调包。' });
      return;
    }
    const idset = new Set(chosen.map((card: any) => card.id));
    player.hand = player.hand.filter((card: any) => !idset.has(card.id));
    for (let i = 0; i < chosen.length; i += 1) {
      if (!game.deck.length) game.deck = makeDeck();
      player.hand.push(game.deck.pop());
    }
    player.item = null;
    pushLog(room, `${player.name} 用了调包，换掉 ${chosen.length} 张牌`);
    broadcastState(room);
  }
}

function handleChat(conn: any, msg: any) {
  const room = rooms.get(conn.roomCode);
  if (!room || (!room.game && room.status !== 'lobby')) return;
  const player = byId(room, conn.playerId);
  if (!player || player.left) return;
  const text = cleanText(msg.text, 24);
  if (!text) return;
  const entry = chatEntry(player, text);
  room.chat.push(entry);
  if (room.chat.length > 60) room.chat.shift();
  broadcast(room, { t: 'chat', from: entry.from, name: entry.name, text: entry.text, kind: 'quick', at: entry.at });
}

function handleVoice(conn: any, msg: any) {
  const room = rooms.get(conn.roomCode);
  if (!room) return;
  const player = byId(room, conn.playerId);
  if (!player || player.left) return;
  const to = byId(room, String(msg.to || ''));
  if (!to || !to.connected || to.id === player.id) return;
  if (!msg.data || typeof msg.data !== 'object') return;
  sendTo(to, { t: 'voice', from: player.id, data: msg.data });
}

function handleReady(conn: any, msg: any) {
  const room = rooms.get(conn.roomCode);
  if (!room || room.status !== 'lobby') return;
  const player = byId(room, conn.playerId);
  if (!player || player.left) return;
  player.ready = !!msg.ready;
  broadcastRoom(room);
}

function handleStart(conn: any) {
  const room = rooms.get(conn.roomCode);
  if (!room || room.status !== 'lobby') return;
  const player = byId(room, conn.playerId);
  if (!player || player.id !== room.hostId) {
    send(conn.ws, { t: 'error', code: 'NOT_HOST', message: '只有房主能开桌。' });
    return;
  }
  room.players = room.players.filter((item: any) => item.connected && !item.left);
  if (room.players.length < MIN_PLAYERS) {
    send(conn.ws, { t: 'error', code: 'NOT_ENOUGH', message: '至少 2 个人才能开桌。' });
    return;
  }
  if (!room.players.every((item: any) => item.ready)) {
    send(conn.ws, { t: 'error', code: 'NOT_READY', message: '还有人没准备。' });
    return;
  }
  notice(room, '开桌，发牌。', 'good');
  newGame(room);
}

function handleRematch(conn: any) {
  const room = rooms.get(conn.roomCode);
  if (!room || !room.game || room.game.phase !== 'over') return;
  const player = byId(room, conn.playerId);
  if (!player || player.id !== room.hostId) {
    send(conn.ws, { t: 'error', code: 'NOT_HOST', message: '只有房主能再开一局。' });
    return;
  }
  room.players = room.players.filter((item: any) => item.connected && !item.left);
  if (room.players.length < MIN_PLAYERS) {
    send(conn.ws, { t: 'error', code: 'NOT_ENOUGH', message: '至少 2 个人才能再开一局。' });
    return;
  }
  notice(room, '新的一桌，重新发牌。', 'good');
  newGame(room);
}

/* ------------------------------------------------------------------ */
/* websocket plumbing                                                  */
/* ------------------------------------------------------------------ */

function handleMessage(conn: any, msg: any) {
  if (!msg || typeof msg !== 'object') return;
  const type = String(msg.t || '');
  switch (type) {
    case 'create': createRoom(conn, msg); break;
    case 'join': joinRoom(conn, msg); break;
    case 'resume': resumeRoom(conn, msg); break;
    case 'ready': handleReady(conn, msg); break;
    case 'start': handleStart(conn); break;
    case 'play': handlePlay(conn, msg); break;
    case 'challenge': handleChallenge(conn); break;
    case 'item': handleItem(conn, msg); break;
    case 'advance': handleAdvance(conn, msg); break;
    case 'rematch': handleRematch(conn); break;
    case 'chat': handleChat(conn, msg); break;
    case 'voice': handleVoice(conn, msg); break;
    case 'leave': leaveRoom(conn); break;
    case 'ping': send(conn.ws, { t: 'pong' }); break;
    default: break;
  }
}

function onSocketClose(conn: any, socket: any) {
  const room = rooms.get(conn.roomCode);
  const playerId = conn.playerId;
  conn.roomCode = null;
  conn.playerId = null;
  if (!room) return;
  const player = byId(room, playerId);
  if (!player || player.socket !== socket) return;
  player.socket = null;
  player.connected = false;
  clearTimeout(player.disconnectTimer);
  player.disconnectTimer = setTimeout(() => {
    const live = rooms.get(room.code);
    if (!live) return;
    const target = byId(live, player.id);
    if (!target || target.connected) return;
    forfeitPlayer(live, target, 'timeout');
  }, DISCONNECT_GRACE_MS);

  ensureHost(room);
  broadcastRoom(room);
  if (room.game && room.game.phase !== 'over') broadcastState(room);
  notice(room, `${player.name} 掉线了，等待重连`, 'warn');
  if (!connectedPlayers(room).length) scheduleRoomCleanup(room, ROOM_EMPTY_MS);
}

function onConnection(socket: any) {
  connSeq += 1;
  const conn = {
    id: connSeq,
    ws: socket,
    roomCode: null,
    playerId: null,
    openedAt: Date.now(),
    lastSeen: Date.now(),
    windowStart: Date.now(),
    windowCount: 0
  };
  conns.add(conn);

  /* Deno 的 WebSocket 在 upgrade 返回前处于 CONNECTING，必须等 onopen 再发首包。 */
  socket.onopen = () => {
    conn.lastSeen = Date.now();
    send(socket, {
      t: 'welcome',
      server: 'liars-bar-neon',
      turnMs: TURN_MS,
      maxPlayers: MAX_PLAYERS
    });
  };

  socket.onmessage = (event: any) => {
    const now = Date.now();
    conn.lastSeen = now;
    if (now - conn.windowStart > 1000) {
      conn.windowStart = now;
      conn.windowCount = 0;
    }
    conn.windowCount += 1;
    if (conn.windowCount > 40) {
      if (conn.windowCount === 41) {
        send(socket, { t: 'error', code: 'RATE_LIMIT', message: '操作太快了，缓一下。' });
      }
      return;
    }
    if (typeof event.data !== 'string') return;
    const raw = event.data;
    if (raw.length > 40000) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }
    try {
      handleMessage(conn, msg);
    } catch (err) {
      console.error('[ws] handler error', err);
      send(socket, { t: 'error', code: 'SERVER_ERROR', message: '服务端出了点问题，再试一次。' });
    }
  };

  socket.onclose = () => {
    conns.delete(conn);
    onSocketClose(conn, socket);
  };
  socket.onerror = () => {};
}

/* 客户端每 20s 发一次 ping；75s 没有任何消息就当成死连接收掉。 */
const heartbeat = setInterval(() => {
  const now = Date.now();
  conns.forEach((conn: any) => {
    if (now - conn.lastSeen < 75000) return;
    try { conn.ws.close(4000, 'idle'); } catch (err) { /* ignore */ }
  });
}, 30000);

const sweeper = setInterval(() => {
  const now = Date.now();
  rooms.forEach((room: any) => {
    if (!connectedPlayers(room).length && now - room.updatedAt > ROOM_EMPTY_MS) {
      destroyRoom(room, 'idle');
    }
  });
}, 60000);

/* ------------------------------------------------------------------ */
/* http                                                                */
/* ------------------------------------------------------------------ */

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self)',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws: wss:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
};

const port = Number(Deno.env.get('PORT') || 8000);

Deno.serve({ port }, (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === '/health') {
    const payload = JSON.stringify({
      ok: true,
      rooms: rooms.size,
      players: Array.from(rooms.values()).reduce((sum: number, room: any) => sum + room.players.length, 0),
      uptime: Math.round((Date.now() - startedAt) / 1000),
      fast: FAST,
      runtime: 'deno'
    });
    return new Response(payload, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  if (url.pathname === '/favicon.ico') {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'public, max-age=86400' } });
  }

  if (url.pathname === '/ws') {
    const upgrade = (req.headers.get('upgrade') || '').toLowerCase();
    if (upgrade !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    onConnection(socket);
    return response;
  }

  if (url.pathname !== '/' && url.pathname !== '/index.html') {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  return new Response(INDEX_HTML, { headers: HTML_HEADERS });
});

console.log('');
console.log('  骗子酒馆 · NEON  (Deno Deploy)');
console.log(`  监听端口   ${port}`);
console.log(`  回合计时   ${Math.round(TURN_MS / 1000)}s${FAST ? '  (TEST_FAST)' : ''}`);
console.log('');
