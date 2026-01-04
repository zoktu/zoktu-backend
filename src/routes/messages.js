import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getModelForRoom } from '../models/Message.js';
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
      const mapped = docs.reverse().map(d => ({ id: d._id.toString(), roomId: d.roomId, senderId: d.senderId, senderName: d.senderName, content: d.content, type: d.type, timestamp: d.createdAt }));
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

export default router;
