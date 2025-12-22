// Simple WebSocket multiplayer server with room codes + shared seed
// Run: npm install && npm start
import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function makeSeed() {
  // 32-bit unsigned
  return Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
}

const server = http.createServer();
const wss = new WebSocketServer({ server });

/** rooms: code -> { seed:number, clients:Set<WebSocket>, states:Map<string, any> } */
const rooms = new Map();
/** client meta */
const meta = new Map(); // ws -> { id, code|null, isHost:boolean }

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function broadcast(code, obj, exceptWs = null) {
  const room = rooms.get(code);
  if (!room) return;
  for (const c of room.clients) {
    if (c.readyState !== 1) continue; // OPEN
    if (exceptWs && c === exceptWs) continue;
    send(c, obj);
  }
}

function newClientId() {
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).toUpperCase();
}

wss.on("connection", (ws) => {
  const id = newClientId();
  meta.set(ws, { id, code: null, isHost: false });
  send(ws, { type: "hello", id });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    const m = meta.get(ws);
    if (!m) return;

    if (msg.type === "create_room") {
      let code;
      do { code = makeCode(); } while (rooms.has(code));
      const seed = makeSeed();
      rooms.set(code, { seed, clients: new Set(), states: new Map() });

      // join as host
      m.code = code;
      m.isHost = true;
      rooms.get(code).clients.add(ws);
      rooms.get(code).states.set(m.id, null);

      send(ws, { type: "room_created", code, seed, id: m.id });
      broadcast(code, { type: "room_players", players: [...rooms.get(code).states.keys()] });
      return;
    }

    if (msg.type === "join_room") {
      const code = String(msg.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: "error", error: "SALA_NAO_EXISTE" });
        return;
      }
      m.code = code;
      m.isHost = false;
      room.clients.add(ws);
      room.states.set(m.id, null);

      // send seed + existing players
      send(ws, { type: "joined", code, seed: room.seed, id: m.id, players: [...room.states.keys()] });
      broadcast(code, { type: "player_joined", id: m.id }, ws);
      broadcast(code, { type: "room_players", players: [...room.states.keys()] });
      return;
    }

    if (msg.type === "leave_room") {
      if (!m.code) return;
      const code = m.code;
      const room = rooms.get(code);
      if (room) {
        room.clients.delete(ws);
        room.states.delete(m.id);
        broadcast(code, { type: "player_left", id: m.id });
        broadcast(code, { type: "room_players", players: [...room.states.keys()] });
        if (room.clients.size === 0) rooms.delete(code);
      }
      m.code = null;
      m.isHost = false;
      send(ws, { type: "left" });
      return;
    }

    if (msg.type === "state") {
      if (!m.code) return;
      const room = rooms.get(m.code);
      if (!room) return;
      room.states.set(m.id, msg.state || null);
      broadcast(m.code, { type: "state", id: m.id, state: msg.state || null }, ws);
      return;
    }

    if (msg.type === "ping") {
      send(ws, { type: "pong", t: Date.now() });
      return;
    }
  });

  ws.on("close", () => {
    const m = meta.get(ws);
    meta.delete(ws);
    if (!m || !m.code) return;
    const code = m.code;
    const room = rooms.get(code);
    if (room) {
      room.clients.delete(ws);
      room.states.delete(m.id);
      broadcast(code, { type: "player_left", id: m.id });
      broadcast(code, { type: "room_players", players: [...room.states.keys()] });
      if (room.clients.size === 0) rooms.delete(code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`[MP] WebSocket server on :${PORT}`);
});
