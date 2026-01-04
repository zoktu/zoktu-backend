import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getModelForRoom, RoomMessage, DMMessage, RandomMessage } from '../models/Message.js';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import Room from '../models/Room.js';
import requireVerifiedForHighRisk from '../middleware/riskGuard.js';

const router = Router();
export const messages = new Map();
// Simple in-memory throttle per IP+room to avoid abusive polling
const lastMessageRequest = new Map(); // key: `${ip}:${roomId}` -> timestamp
const MIN_INTERVAL_MS = 800; // minimum allowed interval between requests per IP+room

// Per-user message rate tracking and mute map
const userMessageWindow = new Map(); // userId -> { count, windowStart }
const mutedUsers = new Map(); // userId -> muteUntil timestamp
const MESSAGE_WINDOW_MS = 15000; // 15s window
const MESSAGE_LIMIT = 8; // more than this in window => mute
const MUTE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_WORDS = 200; // maximum words allowed per message

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

router.get('/rooms/:roomId/messages', (req, res) => {
  const roomId = req.params.roomId;
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const key = `${ip}:${roomId}`;
  const now = Date.now();
  const last = lastMessageRequest.get(key) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    // too many requests
    return res.status(429).json({ message: 'Too many requests' });
  }
  lastMessageRequest.set(key, now);

  // load from DB (most recent first)
  (async () => {
    try {
      const roomDoc = await Room.findById(roomId).lean().catch(() => null);
      const Model = getModelForRoom(roomDoc);
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
      const docs = await Model.find({ roomId }).sort({ createdAt: -1 }).limit(limit).lean();
      // identify current user from Authorization header (optional)
      let currentUserId = null;
      try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (token) {
          const payload = jwt.verify(token, env.jwtSecret);
          currentUserId = payload?.id || null;
        }
      } catch (e) {
        currentUserId = null;
      }

      const mapped = docs.reverse().map(d => {
        const meta = d.meta || {};
        let viewedEntry = null;
        if (currentUserId && Array.isArray(meta.viewed)) {
          viewedEntry = meta.viewed.find(v => v.userId === currentUserId) || null;
        }
        const expireAt = viewedEntry ? (viewedEntry.expireAt ? new Date(viewedEntry.expireAt).toISOString() : null) : null;
        const expiredForYou = expireAt ? (Date.now() > new Date(expireAt).getTime()) : false;
        return ({ id: d._id.toString(), roomId: d.roomId, senderId: d.senderId, senderName: d.senderName, content: d.content, type: d.type, timestamp: d.createdAt, meta, viewedByCurrentUser: Boolean(viewedEntry), expireAt, expiredForCurrentUser: expiredForYou });
      });
      res.json(mapped);
    } catch (e) {
      // fallback to in-memory cache
      const list = messages.get(roomId) || [];
      res.json(list.slice(-(Number(req.query.limit) || 50)));
    }
  })();
});

router.post('/rooms/:roomId/messages', requireVerifiedForHighRisk, asyncHandler(async (req, res) => {
  const roomId = req.params.roomId;
  const { senderId, content } = req.body || {};
  // word limit check
  const words = (content || '').trim().split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) {
    return res.status(400).json({ message: `Message too long (max ${MAX_WORDS} words)` });
  }

  // mute check
  if (isUserMuted(senderId)) {
    const until = mutedUsers.get(senderId);
    return res.status(403).json({ message: 'You are muted for spamming', mutedUntil: until });
  }

  // Check room-level bans/mutes (by userId or IP)
  try {
    const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '').toString().split(',')[0].trim();
    const roomDoc = await Room.findById(roomId).lean().catch(() => null);
    if (roomDoc) {
      // check direct userId ban
      if (Array.isArray(roomDoc.bannedUsers) && senderId && roomDoc.bannedUsers.includes(senderId)) {
        return res.status(403).json({ message: 'You are banned from this room' });
      }
      // check user's linked guestId
      try {
        const u = senderId ? await User.findById(senderId).lean().catch(() => null) : null;
        if (u && u.guestId && Array.isArray(roomDoc.bannedUsers) && roomDoc.bannedUsers.includes(u.guestId)) {
          return res.status(403).json({ message: 'You are banned from this room' });
        }
      } catch (e) {}
      if (Array.isArray(roomDoc.bannedIPs) && ip && roomDoc.bannedIPs.includes(ip)) {
        return res.status(403).json({ message: 'Your IP is banned from this room' });
      }
      // check mutedUsers array
      if (Array.isArray(roomDoc.mutedUsers) && senderId) {
        const mu = roomDoc.mutedUsers.find(m => m.userId === senderId && new Date(m.until) > new Date());
        if (mu) return res.status(403).json({ message: 'You are muted in this room', mutedUntil: mu.until });
      }
      if (Array.isArray(roomDoc.mutedIPs) && ip) {
        const mi = roomDoc.mutedIPs.find(m => m.ip === ip && new Date(m.until) > new Date());
        if (mi) return res.status(403).json({ message: 'Your IP is muted in this room', mutedUntil: mi.until });
      }
    }
  } catch (e) {
    // ignore enforcement errors
  }

  // register message for rate tracking
  const muteStart = registerUserMessage(senderId);
  if (muteStart) {
    return res.status(403).json({ message: 'You have been muted for 5 minutes due to spam', mutedUntil: muteStart });
  }

  // persist to DB using correct model for the room
  const roomDoc = await Room.findById(roomId).lean().catch(() => null);
  const Model = getModelForRoom(roomDoc);
  const doc = new Model({ roomId, senderId, senderName: req.body.senderName || '', content, type: req.body.type || 'text' });
  await doc.save();
  // keep in-memory cache for quick reads (optional)
  try {
    const list = messages.get(roomId) || [];
    list.push({ id: doc._id.toString(), roomId, senderId, senderName: doc.senderName, content: doc.content, timestamp: doc.createdAt.toISOString() });
    messages.set(roomId, list);
  } catch (e) {}
  res.json({ id: doc._id.toString(), roomId, senderId, senderName: doc.senderName, content: doc.content, timestamp: doc.createdAt.toISOString() });
}));

router.patch('/messages/:id', (req, res) => {
  const updated = { id: req.params.id, ...req.body, isEdited: true, editedAt: new Date().toISOString() };
  res.json(updated);
});

router.delete('/messages/:id', (req, res) => {
  res.json({ message: 'deleted', id: req.params.id });
});

router.post('/messages/:id/reactions', (req, res) => {
  res.json({ message: 'reaction added', emoji: req.body.emoji, userId: req.body.userId });
});

router.delete('/messages/:id/reactions', (req, res) => {
  res.json({ message: 'reaction removed', emoji: req.body?.emoji, userId: req.body?.userId });
});

// Mark a message as viewed by the current user (per-user ephemeral view)
router.post('/messages/:id/view', asyncHandler(async (req, res) => {
  const id = req.params.id;
  // require auth
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (e) {
    return res.status(401).json({ message: 'Invalid token' });
  }
  const userId = payload?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const durationSeconds = Number(req.body?.durationSeconds) || 10; // default 10s
  const expireAt = new Date(Date.now() + Math.max(1, durationSeconds) * 1000);

  // Try to find the message in any of the collections
  let doc = await RoomMessage.findById(id).catch(() => null);
  if (!doc) doc = await DMMessage.findById(id).catch(() => null);
  if (!doc) doc = await RandomMessage.findById(id).catch(() => null);
  if (!doc) return res.status(404).json({ message: 'Message not found' });

  const meta = doc.meta || {};
  meta.viewed = Array.isArray(meta.viewed) ? meta.viewed : [];
  const existing = meta.viewed.find(v => v.userId === userId);
  const now = new Date();
  if (existing) {
    existing.viewedAt = now;
    existing.expireAt = expireAt;
  } else {
    meta.viewed.push({ userId, viewedAt: now, expireAt });
  }
  doc.meta = meta;
  await doc.save();
  res.json({ message: 'view recorded', expireAt: expireAt.toISOString() });
}));

export default router;
