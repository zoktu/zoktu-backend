import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { Server as IOServer } from 'socket.io';
import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import routes from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createServer } from 'http';
import User from './models/User.js';
import Room from './models/Room.js';
import DMRoom from './models/DMRoom.js';
import { checkGlobalBan } from './middleware/globalBanMiddleware.js';
import GlobalBan from './models/GlobalBan.js';
import { containsBlockedExternalLink } from './middleware/profanityFilter.js';
import { upsertUserInMemory, updateUserPresenceInMemory } from './lib/userStore.js';

const app = express();

const buildAllowedOrigins = () => {
  const raw = String(env.clientOrigin || '').trim();
  const fromEnv = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const defaults = [
    'https://zoktu.com',
    'https://www.zoktu.com',
    'http://localhost:8080',
    'http://localhost:5173'
  ];

  return Array.from(new Set([...defaults, ...fromEnv]));
};

const allowedOrigins = buildAllowedOrigins();

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (env.nodeEnv !== 'production') return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true
};

// Allow stricter CORS in production, but permit known frontend origins.
app.use(cors(corsOptions));
app.use(helmet());
// HTTP response compression (gzip/brotli where supported)
app.use(compression());
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
 
 // Cache-Control middleware to prevent stale data/UI issues
 app.use((req, res, next) => {
   res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
   res.set('Pragma', 'no-cache');
   res.set('Expires', '0');
   next();
 });


app.get('/', (req, res) => {
  res.json({ 
    message: 'Zoktu API Server', 
    status: 'running',
    endpoints: '/api/*' 
  });
});

app.use('/api', checkGlobalBan, routes);

app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

app.use(errorHandler);

// HTTP server + socket.io for real-time pairing/messaging
const httpServer = createServer(app);
const io = new IOServer(httpServer, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'] }
});
app.set('io', io);

// Simple in-memory socket registries and waiting queue for random pairing
const socketsByUser = new Map(); // userId -> socket
const socketCountByUser = new Map(); // userId -> count (supports multiple tabs/devices)
const waitingSockets = [];
const messages = new Map(); // roomId -> message[]
// Per-user message rate tracking and mute map (same rules as REST)
const userMessageWindow = new Map(); // userId -> { count, windowStart }
const mutedUsers = new Map(); // userId -> muteUntil timestamp
const MESSAGE_WINDOW_MS = 15000; // 15s window
const MESSAGE_LIMIT = 8; // more than this in window => mute
const MUTE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_WORDS = 300; // maximum words allowed per message

const updateRoomDocById = async (id, update) => {
  if (!id) return null;
  const preferDm = String(id).startsWith('dm-');
  const primary = preferDm ? DMRoom : Room;
  const secondary = preferDm ? Room : DMRoom;

  await primary.findByIdAndUpdate(id, update).catch(() => null);
  let doc = await primary.findById(id).lean().catch(() => null);
  if (doc) return doc;

  await secondary.findByIdAndUpdate(id, update).catch(() => null);
  doc = await secondary.findById(id).lean().catch(() => null);
  return doc;
};

const roomCache = new Map();
const ROOM_CACHE_TTL = 30000; // 30 seconds

const getRoomDocById = async (id) => {
  if (!id) return null;
  
  const cached = roomCache.get(id);
  if (cached && (Date.now() - cached.ts < ROOM_CACHE_TTL)) {
    return cached.doc;
  }

  const preferDm = String(id).startsWith('dm-');
  const primary = preferDm ? DMRoom : Room;
  const secondary = preferDm ? Room : DMRoom;

  let doc = await primary.findById(id).lean().catch(() => null);
  if (!doc) {
    doc = await secondary.findById(id).lean().catch(() => null);
  }

  if (doc) {
    roomCache.set(id, { doc, ts: Date.now() });
  }
  return doc;
};

const isUserMuted = (userId) => {
  if (!userId) return false;
  const until = mutedUsers.get(userId) || 0;
  if (Date.now() < until) return true;
  if (until) mutedUsers.delete(userId);
  return false;
};

const registerUserMessage = (userId) => {
  if (!userId) return null;
  const now = Date.now();
  const record = userMessageWindow.get(userId) || { count: 0, windowStart: now };
  if (now - record.windowStart > MESSAGE_WINDOW_MS) {
    record.count = 1;
    record.windowStart = now;
  } else {
    record.count += 1;
  }
  userMessageWindow.set(userId, record);
  if (record.count > MESSAGE_LIMIT) {
    const until = Date.now() + MUTE_MS;
    mutedUsers.set(userId, until);
    return until;
  }
  return null;
};

const markUserPresence = async (uid, isOnline) => {
  const id = uid ? String(uid) : '';
  if (!id) return;
  try {
    await User.findOneAndUpdate(
      { $or: [{ _id: id }, { guestId: id }, { email: id }] },
      {
        $set: {
          isOnline: Boolean(isOnline),
          ...(isOnline ? {} : { lastSeen: new Date() })
        }
      },
      { new: false }
    ).lean();
    updateUserPresenceInMemory(id, isOnline);
  } catch (e) {
    // best-effort; ignore
  }
};

io.on('connection', (socket) => {
  const userId = socket.handshake.query?.userId || socket.handshake.auth?.userId || null;
  const effectiveUserId = userId ? String(userId) : null;
  if (effectiveUserId) {
    // Check if user or IP is globally banned
    const ip = socket.handshake.address;
    (async () => {
      const isBanned = await GlobalBan.findOne({
        $or: [
          { userId: effectiveUserId },
          { ip }
        ],
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }]
      }).lean();

      if (isBanned) {
        socket.emit('global:kick', { reason: isBanned.reason });
        socket.disconnect(true);
        return;
      }
      
      socketsByUser.set(effectiveUserId, socket);
      socketCountByUser.set(effectiveUserId, (socketCountByUser.get(effectiveUserId) || 0) + 1);
      markUserPresence(effectiveUserId, true);
      io.emit('presence:update', { userId: effectiveUserId, isOnline: true });
    })();
  }

  // Allow clients (REST-created rooms/DMs) to join a room for realtime events
  socket.on('room:join', (data) => {
    try {
      const roomId = data?.roomId ? String(data.roomId) : null;
      if (!roomId) return;
      socket.join(roomId);
    } catch (e) {}
  });

  socket.on('room:leave', (data) => {
    try {
      const roomId = data?.roomId ? String(data.roomId) : null;
      if (!roomId) return;
      socket.leave(roomId);
    } catch (e) {}
  });

  // Typing indicators (no persistence)
  socket.on('room:typing', (data) => {
    try {
      const roomId = data?.roomId ? String(data.roomId) : null;
      if (!roomId) return;
      const fromUserId = data?.userId ? String(data.userId) : (userId ? String(userId) : null);
      const fromUserName = data?.userName ? String(data.userName) : '';
      socket.to(roomId).emit('room:typing', { roomId, userId: fromUserId, userName: fromUserName });
    } catch (e) {}
  });

  socket.on('room:typing-stop', (data) => {
    try {
      const roomId = data?.roomId ? String(data.roomId) : null;
      if (!roomId) return;
      const fromUserId = data?.userId ? String(data.userId) : (userId ? String(userId) : null);
      const fromUserName = data?.userName ? String(data.userName) : '';
      socket.to(roomId).emit('room:typing-stop', { roomId, userId: fromUserId, userName: fromUserName });
    } catch (e) {}
  });

  socket.on('disconnect', () => {
    try {
      if (effectiveUserId) {
        const next = (socketCountByUser.get(effectiveUserId) || 1) - 1;
        if (next <= 0) {
          socketCountByUser.delete(effectiveUserId);
          socketsByUser.delete(effectiveUserId);
          markUserPresence(effectiveUserId, false);
          io.emit('presence:update', { userId: effectiveUserId, isOnline: false });
        } else {
          socketCountByUser.set(effectiveUserId, next);
        }
      }
    } catch (e) {}
    // remove from waiting queue if present
    const idx = waitingSockets.findIndex(w => w.socket.id === socket.id);
    if (idx !== -1) waitingSockets.splice(idx, 1);

    // Notify other participants in any rooms this socket was in that partner left
    try {
      for (const roomId of socket.rooms) {
        if (roomId === socket.id) continue;
        // emit to remaining members
        socket.to(roomId).emit('room:partner-left', { roomId, userId: effectiveUserId || userId });
      }
    } catch (e) {}
  });

  // Join random queue
  socket.on('random:join', async (data) => {
    const uid = data?.userId || userId || `guest-${socket.id}`;
    
    // Purge dead sockets from the queue while searching
    while (waitingSockets.length > 0) {
      const waiter = waitingSockets.shift();
      
      // Basic check: is the waiter still connected?
      if (!waiter || !waiter.socket || !waiter.socket.connected) {
        continue;
      }
      
      // Basic check: is it NOT me? (Same user id or guest id can't match)
      if (String(waiter.uid) === String(uid)) {
        // Technically this shouldn't happen with unique guest ids, 
        // but if a logged in user opens two tabs, we just add them back to the end
        // wait, actually we should just skip them for now
        waitingSockets.push(waiter);
        break; // Stop looking for now or we might infinite loop if it's just us
      }

      // We found a valid match!
      // Use a more global-unique ID to prevent collisions
      const randomSuffix = Math.random().toString(36).slice(2, 7);
      const roomId = `dm-${Date.now()}-${randomSuffix}`;
      
      try {
        // Have both sockets join the room
        socket.join(roomId);
        waiter.socket.join(roomId);
        
        // Persist DM room in DB
        const participants = [String(waiter.uid), String(uid)].sort();
        const doc = new DMRoom({ 
          _id: roomId, 
          type: 'dm', 
          category: 'random', 
          participants: participants, 
          members: participants, 
          createdBy: String(waiter.uid) 
        });
        await doc.save();
        
        console.log(`[Socket] Random match: ${waiter.uid} <-> ${uid} in room ${roomId}`);
        
        // Notify both clients
        socket.emit('random:matched', { roomId, partnerId: waiter.uid });
        waiter.socket.emit('random:matched', { roomId, partnerId: uid });
        return;
      } catch (err) {
        console.error('[Socket] Failed to create random match room:', err);
        // If DB save failed (unlikely now with suffix), we ignore and move on?
        // Actually, we should still notify them or they get stuck.
        socket.emit('random:matched', { roomId, partnerId: waiter.uid });
        waiter.socket.emit('random:matched', { roomId, partnerId: uid });
        return;
      }
    }

    // No valid match found -> add to waiting list
    // First, remove any existing entry for this socket if they are re-joining
    const existingIdx = waitingSockets.findIndex(w => w.socket.id === socket.id);
    if (existingIdx !== -1) waitingSockets.splice(existingIdx, 1);
    
    waitingSockets.push({ socket, uid, createdAt: Date.now() });
    
    // auto-timeout after 25s (increased slightly)
    setTimeout(() => {
      const idx = waitingSockets.findIndex(w => w.socket.id === socket.id);
      if (idx !== -1) {
        waitingSockets.splice(idx, 1);
        socket.emit('random:timeout');
      }
    }, 25000);
  });

  socket.on('random:leave', () => {
    const idx = waitingSockets.findIndex(w => w.socket.id === socket.id);
    if (idx !== -1) waitingSockets.splice(idx, 1);
  });

  // Explicitly end a room (user requested end)
  socket.on('room:end', (data) => {
    try {
      const roomId = data?.roomId;
      if (!roomId) return;
      // notify all in room
      io.to(roomId).emit('room:ended', { roomId, by: userId || null });
      // mark room inactive in DB (best-effort)
      try { updateRoomDocById(roomId, { isActive: false }).catch(() => {}); } catch (e) {}
      // optionally force leave
      const socketsInRoom = io.sockets.adapter.rooms.get(roomId) || new Set();
      for (const sid of socketsInRoom) {
        const s = io.sockets.sockets.get(sid);
        try { s.leave(roomId); } catch (e) {}
      }
    } catch (e) {
      // ignore
    }
  });

  // Room messaging: accept { roomId, senderId, senderName, content }
  socket.on('room:message', (payload) => {
    try {
      const { roomId, senderId, senderName, content } = payload || {};
      if (!roomId || !content) return;

      // Allow only zoktu.com links; block other external links.
      try {
        if (containsBlockedExternalLink(content)) {
          socket.emit('message:error', { message: 'Message removed: external links are not allowed (only zoktu.com allowed)' });
          return;
        }
      } catch (e) {
        // fail-open
      }

      // word limit
      const words = (content || '').trim().split(/\s+/).filter(Boolean).length;
      if (words > MAX_WORDS) {
        socket.emit('message:error', { message: `Message too long (max ${MAX_WORDS} words)` });
        return;
      }

      // mute check
      if (isUserMuted(senderId)) {
        const until = mutedUsers.get(senderId);
        socket.emit('muted', { mutedUntil: until });
        return;
      }

      const muteStart = registerUserMessage(senderId);
      if (muteStart) {
        socket.emit('muted', { mutedUntil: muteStart });
        return;
      }

      // persist message to DB
      (async () => {
        try {
          // determine room type and pick the model
          const roomDoc = await getRoomDocById(roomId);
          const Model = (await import('./models/Message.js')).getModelForRoom(roomDoc);
          
          // Anonymity for random chats
          const isRandom = roomDoc && roomDoc.category === 'random';
          const nameForDb = senderName || '';
          
          const doc = new Model({ roomId, senderId, senderName: nameForDb, content, type: 'text' });
          await doc.save();
          
          const msg = { 
            id: doc._id.toString(), 
            roomId, 
            senderId, 
            senderName: isRandom ? 'Stranger' : (doc.senderName || senderId || 'User'), 
            content: doc.content, 
            timestamp: doc.createdAt.toISOString() 
          };
          
          // update in-memory cache
          try {
            const list = messages.get(roomId) || [];
            list.push(msg);
            messages.set(roomId, list.slice(-100)); // limit cache size
          } catch (e) {}

          // broadcast to room
          io.to(roomId).emit('room:message', msg);
        } catch (e) {
          console.error('[Socket] Message persistence failed:', e);
          // fallback: broadcast without persistence
          const isRandom = roomId.startsWith('dm-'); // heuristic if roomDoc fetch failed
          const fallbackMsg = { 
            id: `msg-${Date.now()}-${Math.floor(Math.random()*1000)}`, 
            roomId, 
            senderId, 
            senderName: isRandom ? 'Stranger' : (senderName || 'User'), 
            content, 
            timestamp: new Date().toISOString() 
          };
          io.to(roomId).emit('room:message', fallbackMsg);
        }
      })();
    } catch (e) {
      // ignore
    }
  });
});

const start = async () => {
  await connectDb();
  // seed in-memory user store from MongoDB
  try {
    const { seedUsersFromDb } = await import('./lib/userStore.js');
    await seedUsersFromDb();
    console.log('✅ Seeded users from DB');
  } catch (e) {
    console.warn('⚠️ Could not seed users from DB', e.message || e);
  }
  // Ensure bot exists and is added to all public/private rooms
  try {
    const botId = env.botId || 'bot-baka';
    const botName = env.botName || 'Baka';
    const botAvatar = env.botAvatar || '';
    const botEnabled = Boolean(env.huggingFaceApiKey) && (String(env.botEnabled || '').toLowerCase() !== 'false');
    if (botEnabled) {
      const doc = await User.findOneAndUpdate(
        { guestId: String(botId) },
        {
          $setOnInsert: {
            guestId: String(botId),
            userType: 'guest',
            displayName: String(botName),
            name: String(botName),
            username: String(botName),
            ...(botAvatar ? { avatar: String(botAvatar), photoURL: String(botAvatar) } : {})
          },
          $set: {
            displayName: String(botName),
            name: String(botName),
            username: String(botName),
            isOnline: true,
            ...(botAvatar ? { avatar: String(botAvatar), photoURL: String(botAvatar) } : {})
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean().exec();
      if (doc) {
        upsertUserInMemory({ ...doc, id: String(doc.guestId || doc._id) });
      }

      await Room.updateMany(
        {
          $or: [
            { type: 'public' },
            { type: 'private', category: { $ne: 'dm' } }
          ]
        },
        { $addToSet: { participants: String(botId), members: String(botId) } }
      ).exec();
    }
  } catch (e) {
    console.warn('⚠️ Could not bootstrap bot', e.message || e);
  }
  httpServer.listen(env.port, () => {
    console.log(`🚀 Backend running on http://localhost:${env.port}`);
  });
};

start();
