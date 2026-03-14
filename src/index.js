import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import routes from './routes/index.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createServer } from 'http';
import { Server as IOServer } from 'socket.io';
import { messages } from './routes/messages.js';
import { updateUserPresenceInMemory, upsertUserInMemory } from './lib/userStore.js';
import Message from './models/Message.js';
import Room from './models/Room.js';
import DMRoom from './models/DMRoom.js';
import User from './models/User.js';

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

app.get('/', (req, res) => {
  res.json({ 
    message: 'Zoktu API Server', 
    status: 'running',
    endpoints: '/api/*' 
  });
});

app.use('/api', routes);

app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

app.use(errorHandler);

// HTTP server + socket.io for real-time pairing/messaging
const httpServer = createServer(app);
const io = new IOServer(httpServer, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'] }
});

// Simple in-memory socket registries and waiting queue for random pairing
const socketsByUser = new Map(); // userId -> socket
const socketCountByUser = new Map(); // userId -> count (supports multiple tabs/devices)
const waitingSockets = [];
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

const getRoomDocById = async (id) => {
  if (!id) return null;
  const preferDm = String(id).startsWith('dm-');
  const primary = preferDm ? DMRoom : Room;
  const secondary = preferDm ? Room : DMRoom;

  let doc = await primary.findById(id).lean().catch(() => null);
  if (doc) return doc;

  doc = await secondary.findById(id).lean().catch(() => null);
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
    socketsByUser.set(effectiveUserId, socket);
    socketCountByUser.set(effectiveUserId, (socketCountByUser.get(effectiveUserId) || 0) + 1);
    markUserPresence(effectiveUserId, true);
    io.emit('presence:update', { userId: effectiveUserId, isOnline: true });
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
    // Try to find a waiting partner
    for (let i = 0; i < waitingSockets.length; i++) {
      const waiter = waitingSockets[i];
      if (waiter.uid !== uid) {
        waitingSockets.splice(i, 1);
        const roomId = `dm-${Date.now()}`;
        // have both sockets join room
        socket.join(roomId);
        try { waiter.socket.join(roomId); } catch (e) {}
        // persist DM room in DB (best-effort)
        try {
          const doc = new DMRoom({ _id: roomId, type: 'dm', category: 'dm', participants: [waiter.uid, uid], members: [waiter.uid, uid], createdBy: waiter.uid });
          await doc.save();
        } catch (e) {}
        // notify both
        socket.emit('random:matched', { roomId, partnerId: waiter.uid });
        try { waiter.socket.emit('random:matched', { roomId, partnerId: uid }); } catch (e) {}
        return;
      }
    }

    // no match -> add to waiting list
    waitingSockets.push({ socket, uid, createdAt: Date.now() });
    // auto-timeout after 20s
    setTimeout(() => {
      const idx = waitingSockets.findIndex(w => w.socket.id === socket.id);
      if (idx !== -1) {
        waitingSockets.splice(idx, 1);
        socket.emit('random:timeout');
      }
    }, 20000);
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
              const doc = new Model({ roomId, senderId, senderName: senderName || '', content, type: 'text' });
              await doc.save();
              const msg = { id: doc._id.toString(), roomId, senderId, senderName: doc.senderName, content: doc.content, timestamp: doc.createdAt.toISOString() };
              // update in-memory cache
              try {
                const list = messages.get(roomId) || [];
                list.push(msg);
                messages.set(roomId, list);
              } catch (e) {}
              // broadcast to room
              io.to(roomId).emit('room:message', msg);
            } catch (e) {
              // fallback: broadcast without persistence
              const fallbackMsg = { id: `msg-${Date.now()}-${Math.floor(Math.random()*1000)}`, roomId, senderId, senderName, content, timestamp: new Date().toISOString() };
              const list = messages.get(roomId) || [];
              list.push(fallbackMsg);
              messages.set(roomId, list);
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
    const botEnabled = Boolean(env.geminiApiKey) && (String(env.botEnabled || '').toLowerCase() !== 'false');
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
