import express from 'express';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { Server as IOServer } from 'socket.io';
import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import routes from './routes/index.js';
import callsRouter from './routes/calls.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createServer } from 'http';
import User from './models/User.js';
import Room from './models/Room.js';
import DMRoom from './models/DMRoom.js';
import { checkGlobalBan } from './middleware/globalBanMiddleware.js';
import GlobalBan from './models/GlobalBan.js';
import { containsBlockedExternalLink } from './middleware/profanityFilter.js';
import { upsertUserInMemory, updateUserPresenceInMemory } from './lib/userStore.js';
import { createSocketIoRedisAdapter } from './lib/redis.js';
import { pruneOldMessagesForRoom } from './lib/messageRetention.js';
import {
  getRoomDocByIdWithCache as getRoomDocById,
  updateRoomDocByIdWithCache as updateRoomDocById
} from './lib/roomCache.js';
import { encryptMessageContent, decryptMessageContent } from './lib/messageCrypto.js';
import { startUserCleanupJob } from './lib/userCleanup.js';

const app = express();
// Trust the first proxy (Render) so rate limiting uses correct client IP instead of Render's proxy IP
app.set('trust proxy', 1);
app.disable('x-powered-by');

const normalizeOrigin = (origin) => String(origin || '').trim().toLowerCase().replace(/\/$/, '');

const buildAllowedOrigins = () => {
  const raw = String(env.clientOrigin || '').trim();
  const fromEnv = raw
    ? raw.split(',').map((s) => normalizeOrigin(s)).filter(Boolean)
    : [];

  const defaults = [
    'https://zoktu.com',
    'https://www.zoktu.com',
    'https://api.zoktu.com',
    'http://localhost:8080',
    'http://localhost:5173'
  ];

  return Array.from(new Set([...defaults.map(normalizeOrigin), ...fromEnv]));
};

const allowedOrigins = buildAllowedOrigins();

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const normalizedOrigin = normalizeOrigin(origin);
    if (allowedOrigins.includes(normalizedOrigin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true
};

const helmetOptions = {
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      formAction: ["'self'"],
      connectSrc: ["'self'", ...allowedOrigins]
    }
  },
  frameguard: {
    action: 'deny'
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  referrerPolicy: {
    policy: 'strict-origin-when-cross-origin'
  }
};

const parsePositiveInt = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const parseIdsCount = (rawIds) => {
  if (Array.isArray(rawIds)) {
    return rawIds
      .flatMap((entry) => String(entry || '').split(','))
      .map((id) => String(id || '').trim())
      .filter(Boolean).length;
  }

  return String(rawIds || '')
    .split(',')
    .map((id) => String(id || '').trim())
    .filter(Boolean).length;
};

const formatSlowRequestPath = (req) => {
  const pathOnly = String(req?.path || req?.url || '').trim();
  const originalUrl = String(req?.originalUrl || pathOnly || '').trim();

  if (pathOnly === '/api/users/batch') {
    const idsCount = parseIdsCount(req?.query?.ids);
    return `${pathOnly}?idsCount=${idsCount}`;
  }

  const MAX_LOG_URL_LENGTH = 220;
  if (originalUrl.length > MAX_LOG_URL_LENGTH) {
    return `${originalUrl.slice(0, MAX_LOG_URL_LENGTH)}…`;
  }

  return originalUrl || pathOnly || '/';
};

// ✅ Security: Rate Limiting — prevents API abuse and brute-force attacks
// General limiter: 120 requests/minute per IP for all API routes
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => env.nodeEnv !== 'production', // only enforce in production
});

// Strict limiter: 10 requests/minute for auth endpoints (login, register, password reset)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please wait a minute.' },
  skip: (req) => env.nodeEnv !== 'production',
});

// Restrict CORS to known frontend origins across environments.
app.use(cors(corsOptions));
app.use(helmet(helmetOptions));
// HTTP response compression (gzip/brotli where supported)
app.use(compression());
const slowApiThresholdMs = parsePositiveInt(env.slowApiThresholdMs, 300);
const shouldSkipAccessLog = (req) => {
  const path = String(req?.path || '').trim();
  return path === '/api/health' || path === '/health' || path === '/' || path.startsWith('/api/sessions');
};
app.use(morgan(env.nodeEnv === 'production' ? 'tiny' : 'dev', { skip: shouldSkipAccessLog }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  // Reduce server time disclosure in default HTTP response headers.
  res.sendDate = false;
  next();
});

// Lightweight slow request monitor for operational visibility.
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (elapsedMs >= slowApiThresholdMs && req.path !== '/api/health' && req.path !== '/health') {
      const logPath = formatSlowRequestPath(req);
      console.warn(`[SLOW_API] ${req.method} ${logPath} -> ${res.statusCode} (${elapsedMs.toFixed(1)}ms)`);
    }
  });
  next();
});
 
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

// Apply rate limiters — auth routes get strict limits, everything else gets general
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth/verify-otp', authLimiter);
app.use('/api/calls', requireAuth, callsRouter);
app.use('/api', generalLimiter, checkGlobalBan, routes);

app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

app.use(errorHandler);

// HTTP server + socket.io for real-time pairing/messaging
const httpServer = createServer(app);
const io = new IOServer(httpServer, {
  cors: {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(normalizeOrigin(origin))) return callback(null, true);
      return callback(new Error(`Socket.IO CORS blocked for origin: ${origin}`));
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});
app.set('io', io);

// Simple in-memory socket registries and waiting queue for random pairing
const socketsByUser = new Map(); // userId -> socket
const socketCountByUser = new Map(); // userId -> count (supports multiple tabs/devices)
const waitingSockets = [];
const randomQueueTimeouts = new Map(); // socketId -> timeout handle
const messages = new Map(); // roomId -> message[]
// Per-user message rate tracking and mute map (same rules as REST)
const userMessageWindow = new Map(); // userId -> { count, windowStart }
const mutedUsers = new Map(); // userId -> muteUntil timestamp
const MESSAGE_WINDOW_MS = 15000; // 15s window
const MESSAGE_LIMIT = 8; // more than this in window => mute
const MUTE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_WORDS = 300; // maximum words allowed per message
const NORMAL_MESSAGE_CHAR_LIMIT = 200;
const VIP_MESSAGE_CHAR_LIMIT = 500;
const ROOM_MESSAGE_RETENTION_LIMIT = 50;

const clearRandomQueueTimeout = (socketId) => {
  const sid = String(socketId || '').trim();
  if (!sid) return;
  const timer = randomQueueTimeouts.get(sid);
  if (timer) {
    clearTimeout(timer);
    randomQueueTimeouts.delete(sid);
  }
};

const clearRandomQueueEntry = (socketId) => {
  const sid = String(socketId || '').trim();
  if (!sid) return;

  const idx = waitingSockets.findIndex((w) => w?.socket?.id === sid);
  if (idx !== -1) waitingSockets.splice(idx, 1);
  clearRandomQueueTimeout(sid);
};

const scheduleRandomQueueTimeout = (socket, timeoutMs = 25000) => {
  const sid = String(socket?.id || '').trim();
  if (!sid) return;

  clearRandomQueueTimeout(sid);
  const timer = setTimeout(() => {
    const idx = waitingSockets.findIndex((w) => w?.socket?.id === sid);
    if (idx !== -1) {
      waitingSockets.splice(idx, 1);
      try {
        socket.emit('random:timeout');
      } catch (e) {
        // ignore
      }
    }
    randomQueueTimeouts.delete(sid);
  }, Math.max(1000, Number(timeoutMs) || 25000));

  randomQueueTimeouts.set(sid, timer);
};

const isVipUserRecord = (userDoc) => {
  if (!userDoc || typeof userDoc !== 'object') return false;
  const userType = String(userDoc.userType || '').toLowerCase();
  const premiumStatus = String(userDoc.premiumStatus || userDoc.subscription?.plan || '').toLowerCase();
  const premiumUntilTs = userDoc.premiumUntil ? new Date(userDoc.premiumUntil).getTime() : 0;
  const hasValidPremiumUntil = Number.isFinite(premiumUntilTs) && premiumUntilTs > Date.now();

  return Boolean(
    userDoc.isPremium === true ||
    userType === 'premium' ||
    premiumStatus === 'premium' ||
    premiumStatus === 'monthly' ||
    premiumStatus === 'yearly' ||
    hasValidPremiumUntil
  );
};

const getMessageCharLimitForSender = async (senderId) => {
  const id = String(senderId || '').trim();
  if (!id) return NORMAL_MESSAGE_CHAR_LIMIT;

  const ors = [{ guestId: id }, { email: id }];
  if (/^[a-f\d]{24}$/i.test(id)) ors.unshift({ _id: id });

  const userDoc = await User.findOne({ $or: ors })
    .select('isPremium userType premiumStatus premiumUntil subscription')
    .lean()
    .catch(() => null);

  return isVipUserRecord(userDoc) ? VIP_MESSAGE_CHAR_LIMIT : NORMAL_MESSAGE_CHAR_LIMIT;
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
    socket.userId = effectiveUserId;
    socket.join(`user:${effectiveUserId}`);
    
    // Check if user or IP is globally banned
    const ip = String(socket.handshake.address || socket.request?.socket?.remoteAddress || '')
      .split(',')[0]
      .trim();
    (async () => {
      const now = new Date();
      const isBanned = await GlobalBan.findOne({
        $and: [
          {
            $or: [
              { userId: effectiveUserId },
              ...(ip ? [{ ip }] : [])
            ]
          },
          {
            $or: [
              { expiresAt: { $exists: false } },
              { expiresAt: null },
              { expiresAt: { $gt: now } }
            ]
          }
        ]
      })
        .select('reason')
        .lean();

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
  socket.on('room:join', async (data) => {
    try {
      const roomId = data?.roomId ? String(data.roomId) : null;
      if (!roomId) return;
      socket.join(roomId);

      // If this is a DM room, tell the partner the user is now active in chat
      if (effectiveUserId) {
        const dmDoc = await DMRoom.findById(roomId).lean().catch(() => null);
        if (dmDoc) {
          io.to(roomId).emit('dm:user:active', { roomId, userId: effectiveUserId });
        }
      }
    } catch (e) {}
  });

  socket.on('room:leave', async (data) => {
    try {
      const roomId = data?.roomId ? String(data.roomId) : null;
      if (!roomId) return;
      socket.leave(roomId);

      // If DM room, tell the partner the user is no longer active in chat
      if (effectiveUserId) {
        const dmDoc = await DMRoom.findById(roomId).lean().catch(() => null);
        if (dmDoc) {
          io.to(roomId).emit('dm:user:inactive', { roomId, userId: effectiveUserId });
        }
      }
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
    clearRandomQueueEntry(socket.id);

    // Notify other participants in any rooms this socket was in that partner left
    try {
      const roomsToClean = [];
      for (const roomId of socket.rooms) {
        if (roomId === socket.id) continue;
        
        // Detect random chat rooms (prefixed with dm- and usually handled as random)
        if (String(roomId).startsWith('dm-')) {
          roomsToClean.push(String(roomId));
        }

        // emit to remaining members
        socket.to(roomId).emit('room:partner-left', { roomId, userId: effectiveUserId || userId });
      }

      // Perform cleanup for random chat segments
      if (roomsToClean.length > 0) {
        (async () => {
          try {
            const { RandomMessage } = await import('./models/Message.js');
            for (const rid of roomsToClean) {
              const roomDoc = await getRoomDocById(rid);
              if (roomDoc && roomDoc.category === 'random') {
                console.log(`[Cleanup] Deleting messages and room metadata for random chat: ${rid}`);
                await RandomMessage.deleteMany({ roomId: rid }).exec();
                await DMRoom.deleteOne({ _id: rid }).exec();
              }
            }
          } catch (e) {
            console.warn('[Cleanup] Random chat cleanup failed:', e?.message || e);
          }
        })();
      }
    } catch (e) {}
  });

  // Join random queue
  socket.on('random:join', async (data) => {
    const uid = data?.userId || userId || `guest-${socket.id}`;
    clearRandomQueueEntry(socket.id);
    
    let waiter = null;
    for (let i = 0; i < waitingSockets.length; i += 1) {
      const candidate = waitingSockets[i];
      if (!candidate || !candidate.socket || !candidate.socket.connected) {
        if (candidate?.socket?.id) {
          clearRandomQueueEntry(candidate.socket.id);
        } else {
          waitingSockets.splice(i, 1);
        }
        i -= 1;
        continue;
      }
      if (candidate.socket.id === socket.id) continue;
      if (String(candidate.uid) === String(uid)) continue;

      waiter = candidate;
      waitingSockets.splice(i, 1);
      clearRandomQueueTimeout(candidate.socket.id);
      break;
    }

    if (waiter) {
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
    waitingSockets.push({ socket, uid, createdAt: Date.now() });

    // auto-timeout after 25s
    scheduleRandomQueueTimeout(socket, 25000);
  });

  socket.on('random:leave', () => {
    clearRandomQueueEntry(socket.id);
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

  // --- Call Signaling Relay ---
  socket.on('call:invite', async (data) => {
    if (!data?.partnerId || !effectiveUserId) return;

    try {
      // Security: Only verified users can initiate calls
      const caller = await User.findById(effectiveUserId).select('emailVerified userType').lean().catch(() => null);
      const isVerified = caller?.emailVerified || caller?.userType === 'premium';
      
      if (!isVerified) {
        socket.emit('call:error', { message: 'Email verification required to initiate calls' });
        return;
      }

      io.to(`user:${data.partnerId}`).emit('call:invite', data);
    } catch (e) {
      console.warn('[Socket] Call invite failed:', e?.message || e);
    }
  });
  socket.on('call:accepted', (data) => {
    if (!data?.partnerId) return;
    io.to(`user:${data.partnerId}`).emit('call:accepted', data);
  });
  socket.on('call:rejected', (data) => {
    if (!data?.partnerId) return;
    io.to(`user:${data.partnerId}`).emit('call:rejected', data);
  });
  socket.on('call:busy', (data) => {
    if (!data?.callerId) return;
    io.to(`user:${data.callerId}`).emit('call:busy', data);
  });
  socket.on('call:ended', (data) => {
    if (!data?.partnerId) return;
    io.to(`user:${data.partnerId}`).emit('call:ended', data);
  });

  // Room messaging: accept { roomId, senderId, senderName, content }
  socket.on('room:message', async (payload) => {
    try {
      const { roomId, senderId, senderName, content } = payload || {};
      if (!roomId || !content) return;
      const contentText = String(content || '');
      const senderIdEffective = effectiveUserId ? String(effectiveUserId) : (senderId ? String(senderId) : null);
      if (!senderIdEffective) return;

      const messageCharLimit = await getMessageCharLimitForSender(senderIdEffective);
      if (contentText.length > messageCharLimit) {
        socket.emit('message:error', { message: `Message too long (max ${messageCharLimit} characters)` });
        return;
      }

      // Allow only zoktu.com links; block other external links.
      try {
        if (containsBlockedExternalLink(contentText)) {
          socket.emit('message:error', { message: 'Message removed: external links are not allowed (only zoktu.com allowed)' });
          return;
        }
      } catch (e) {
        // fail-open
      }

      // word limit
      const words = contentText.trim().split(/\s+/).filter(Boolean).length;
      if (words > MAX_WORDS) {
        socket.emit('message:error', { message: `Message too long (max ${MAX_WORDS} words)` });
        return;
      }

      // mute check
      if (isUserMuted(senderIdEffective)) {
        const until = mutedUsers.get(senderIdEffective);
        socket.emit('muted', { mutedUntil: until });
        return;
      }

      const muteStart = registerUserMessage(senderIdEffective);
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
          
          const doc = new Model({ 
            roomId, 
            senderId: senderIdEffective, 
            senderName: nameForDb, 
            content: isRandom ? encryptMessageContent(contentText) : contentText, 
            type: 'text' 
          });
          await doc.save();
          void pruneOldMessagesForRoom({
            Model,
            roomId: String(roomId),
            keepLatest: ROOM_MESSAGE_RETENTION_LIMIT
          });
          
          const msg = { 
            id: doc._id.toString(), 
            roomId, 
            senderId: senderIdEffective, 
            senderName: isRandom ? 'Stranger' : (doc.senderName || senderId || 'User'), 
            content: isRandom ? decryptMessageContent(doc.content) : doc.content, 
            timestamp: doc.createdAt.toISOString() 
          };
          
          // update in-memory cache
          try {
            const list = messages.get(roomId) || [];
            list.push(msg);
            messages.set(roomId, list.slice(-ROOM_MESSAGE_RETENTION_LIMIT)); // limit cache size
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
            senderId: senderIdEffective, 
            senderName: isRandom ? 'Stranger' : (senderName || 'User'), 
            content: contentText, 
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

  try {
    const redisAdapter = await createSocketIoRedisAdapter();
    if (redisAdapter) {
      io.adapter(redisAdapter);
      console.log('✅ Socket.IO Redis adapter enabled');
    }
  } catch (e) {
    console.warn('⚠️ Could not enable Socket.IO Redis adapter', e?.message || e);
  }

  // Ensure hot-path index exists even when DB_AUTO_INDEX is disabled in production.
  try {
    await User.collection.createIndex({ isOnline: 1 }, { name: 'isOnline_1', background: true });
  } catch (e) {
    // best-effort
  }

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
    const botEnabled = String(env.botEnabled || '').toLowerCase() !== 'false';
    if (botEnabled) {
      const doc = await User.findOneAndUpdate(
        { guestId: String(botId) },
        {
          $setOnInsert: {
            guestId: String(botId),
            userType: 'guest'
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
    // Start automated background tasks
    startUserCleanupJob();
  });
};

start();
