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
  const hi = (Math.random() * 0xffffffff) >>> 0;
  return hi >>> 0;
}

const server = http.createServer();
const wss = new WebSocketServer({ server });

// rooms: code -> { seed, clients:Set<ws>, states:Map<id,state>, hostId:string, bots:any|null }
const rooms = new Map();
// meta: ws -> { id, code, isHost }
const meta = new Map();

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

function pickNewHost(room) {
  // Pick first remaining ws as host
  for (const ws of room.clients) {
    const m = meta.get(ws);
    if (!m) continue;
    // reset all others
    for (const ws2 of room.clients) {
      const mm = meta.get(ws2);
      if (mm) mm.isHost = (ws2 === ws);
    }
    room.hostId = m.id;
    return m.id;
  }
  return null;
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
      rooms.set(code, { seed, clients: new Set(), states: new Map(), hostId: m.id, bots: null, startSeq: 0, collectTaken: new Set(), collectCount: 0, collectSeq: 0, collectSeed: seed });

      // join as host
      m.code = code;
      m.isHost = true;
      const room = rooms.get(code);
      room.clients.add(ws);
      room.states.set(m.id, null);

      send(ws, { type: "room_created", code, seed, id: m.id, hostId: room.hostId, isHost: true, startSeq: room.startSeq || 0, collectTaken: [...(room.collectTaken||[])], collectCount: room.collectCount||0, collectSeed: room.collectSeed||room.seed });
      broadcast(code, { type: "room_players", players: [...room.states.keys()], hostId: room.hostId });
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
      m.isHost = (room.hostId === m.id); // usually false
      room.clients.add(ws);
      room.states.set(m.id, null);

      // send seed + existing players + host + last bots (if any)
      send(ws, {
        type: "joined",
        code,
        seed: room.seed,
        id: m.id,
        players: [...room.states.keys()],
        hostId: room.hostId,
        startSeq: room.startSeq || 0,
        bots: room.bots || null,
        collectTaken: [...(room.collectTaken||[])],
        collectCount: room.collectCount || 0,
        collectSeed: room.collectSeed || room.seed,
      });


      broadcast(code, { type: "player_joined", id: m.id }, ws);
      broadcast(code, { type: "room_players", players: [...room.states.keys()], hostId: room.hostId });
      if (room.bots) {
        // ensure the new joiner gets something right away
        send(ws, { type: "bots_state", bots: room.bots, hostId: room.hostId });
      }
      return;
    }

    if (msg.type === "leave_room") {
      if (!m.code) return;
      const code = m.code;
      const room = rooms.get(code);
      if (room) {
        room.clients.delete(ws);
        room.states.delete(m.id);
        const wasHost = (room.hostId === m.id);

        if (room.clients.size === 0) {
          rooms.delete(code);
          return;
        }

        if (wasHost) {
          const newHostId = pickNewHost(room);
          broadcast(code, { type: "host_changed", hostId: newHostId });
        }

        broadcast(code, { type: "player_left", id: m.id });
        broadcast(code, { type: "room_players", players: [...room.states.keys()], hostId: room.hostId });
      }
      m.code = null;
      m.isHost = false;
      return;
    }

        if (msg.type === "start_game") {
      if (!m.code) return;
      const room = rooms.get(m.code);
      if (!room) return;

      // Autoritativo: apenas o HOST pode iniciar a partida.
      if (m.id !== room.hostId) return;

      room.startSeq = ((room.startSeq || 0) | 0) + 1;
      broadcast(m.code, { type: "start_game", seq: room.startSeq, hostId: room.hostId }, ws);
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

    if (msg.type === "bots_state") {
      if (!m.code) return;
      const room = rooms.get(m.code);
      if (!room) return;

      // Autoritativo: apenas o HOST pode enviar estado de bots.
      if (m.id !== room.hostId) return;

      room.bots = msg.bots || null;
      broadcast(m.code, { type: "bots_state", bots: room.bots, hostId: room.hostId }, ws);
      return;
    }

    
    if (msg.type === "collect_item") {
      if (!m.code) return;
      const room = rooms.get(m.code);
      if (!room) return;

      const id = String(msg.id || "");
      if (!id) return;

      if (!room.collectTaken) room.collectTaken = new Set();
      if (typeof room.collectCount !== "number") room.collectCount = 0;

      if (!room.collectTaken.has(id)) {
        room.collectTaken.add(id);
        room.collectCount = (room.collectCount | 0) + 1;
      }

      // Broadcast incremental update (including sender, para count ficar autoritativo)
      broadcast(m.code, { type: "collect_taken", id, count: room.collectCount | 0 });
      return;
    }

    if (msg.type === "reset_collectibles") {
      if (!m.code) return;
      const room = rooms.get(m.code);
      if (!room) return;

      // Qualquer player pode pedir reset (quando morre) -> reseta pra todos
      room.collectSeq = ((room.collectSeq || 0) | 0) + 1;
      room.collectTaken = new Set();
      room.collectCount = 0;

      // Seed determinístico pra respawn dos itens sem rebuild do mapa
      const base = (room.seed >>> 0);
      const seq = (room.collectSeq >>> 0);
      // Hash simples
      room.collectSeed = (base ^ Math.imul(seq, 2654435761)) >>> 0;

      broadcast(m.code, { type: "collect_reset", seed: room.collectSeed >>> 0 });
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

      if (room.clients.size === 0) {
        rooms.delete(code);
        return;
      }

      const wasHost = (room.hostId === m.id);
      if (wasHost) {
        const newHostId = pickNewHost(room);
        broadcast(code, { type: "host_changed", hostId: newHostId });
      }

      broadcast(code, { type: "player_left", id: m.id });
      broadcast(code, { type: "room_players", players: [...room.states.keys()], hostId: room.hostId });
    }
  });
});

server.listen(PORT, () => {
  console.log(`[MP] WebSocket server on :${PORT}`);
});
