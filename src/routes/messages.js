import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getModelForRoom, RoomMessage, DMMessage, RandomMessage } from '../models/Message.js';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import Room from '../models/Room.js';
import User from '../models/User.js';
import requireVerifiedForHighRisk from '../middleware/riskGuard.js';

const router = Router();
export const messages = new Map();
// Simple in-memory throttle per IP+room to avoid abusive polling
const lastMessageRequest = new Map(); // key: `${ip}:${roomId}` -> timestamp
const MIN_INTERVAL_MS = 800; // minimum allowed interval between requests per IP+room (production)

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

const getAuthPayload = (req) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return null;
    return jwt.verify(token, env.jwtSecret);
  } catch (e) {
    return null;
  }
};

const looksLikeObjectId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));

const normalizeReceiptIds = (auth) => {
  try {
    const raw = Array.isArray(auth?.ids) ? auth.ids.map(String).filter(Boolean) : [];
    const uniq = Array.from(new Set(raw));
    // Avoid emails in receipt arrays; prefer stable ids (mongo _id, guestId, etc.).
    return uniq.filter((id) => {
      if (!id) return false;
      if (String(id).includes('@')) return false;
      return true;
    });
  } catch (e) {
    return [];
  }
};

const isDmRoomDoc = (doc) => Boolean(
  doc && (
    doc.type === 'dm' ||
    doc.category === 'dm' ||
    (doc.type === 'private' && doc.category === 'dm')
  )
);

const canonicalFriendKeyForUserDoc = (doc, fallbackId) => {
  if (doc && doc.userType === 'guest' && doc.guestId) return String(doc.guestId);
  if (doc && doc._id) return String(doc._id);
  return fallbackId ? String(fallbackId) : null;
};

const areUsersFriends = async (aId, bId) => {
  if (!aId || !bId) return false;
  try {
    const aDoc = await User.findOne({ $or: [{ _id: String(aId) }, { guestId: String(aId) }] })
      .select('_id guestId userType friends')
      .lean()
      .catch(() => null);
    if (!aDoc) return false;
    const aFriends = Array.isArray(aDoc.friends) ? aDoc.friends.map(String) : [];

    const bDoc = await User.findOne({ $or: [{ _id: String(bId) }, { guestId: String(bId) }] })
      .select('_id guestId userType')
      .lean()
      .catch(() => null);
    const bKey = canonicalFriendKeyForUserDoc(bDoc, bId);
    if (!bKey) return false;
    return aFriends.includes(String(bKey));
  } catch (e) {
    return false;
  }
};

const getExpandedBlockedSetForUserId = async (userId) => {
  if (!userId) return new Set();
  try {
    const u = await User.findOne({ $or: [{ _id: String(userId) }, { guestId: String(userId) }] })
      .select('blockedUsers')
      .lean()
      .catch(() => null);
    const raw = Array.isArray(u?.blockedUsers) ? u.blockedUsers.map(String).filter(Boolean) : [];
    const out = new Set(raw);

    const objectIdCandidates = raw.filter((v) => looksLikeObjectId(v));
    const guestIdCandidates = raw.filter((v) => String(v).startsWith('guest-'));
    if (objectIdCandidates.length || guestIdCandidates.length) {
      const docs = await User.find({
        $or: [
          ...(objectIdCandidates.length ? [{ _id: { $in: objectIdCandidates } }] : []),
          ...(guestIdCandidates.length ? [{ guestId: { $in: guestIdCandidates } }] : [])
        ]
      })
        .select('_id guestId')
        .lean()
        .exec();
      for (const d of docs || []) {
        if (d?._id) out.add(String(d._id));
        if (d?.guestId) out.add(String(d.guestId));
      }
    }

    return out;
  } catch (e) {
    return new Set();
  }
};

const getExpandedBlockedSetForAuth = async (auth) => {
  try {
    if (!auth?.payload) return new Set();

    const or = [];
    if (auth.payload.email) or.push({ email: String(auth.payload.email) });
    if (auth.primary && looksLikeObjectId(auth.primary)) or.push({ _id: String(auth.primary) });
    if (auth.primary) or.push({ guestId: String(auth.primary) });

    const me = or.length ? await User.findOne({ $or: or }).select('blockedUsers').lean().catch(() => null) : null;
    const raw = Array.isArray(me?.blockedUsers) ? me.blockedUsers.map(String).filter(Boolean) : [];
    const out = new Set(raw);

    const objectIdCandidates = raw.filter((v) => looksLikeObjectId(v));
    const guestIdCandidates = raw.filter((v) => String(v).startsWith('guest-'));
    if (objectIdCandidates.length || guestIdCandidates.length) {
      const docs = await User.find({
        $or: [
          ...(objectIdCandidates.length ? [{ _id: { $in: objectIdCandidates } }] : []),
          ...(guestIdCandidates.length ? [{ guestId: { $in: guestIdCandidates } }] : [])
        ]
      })
        .select('_id guestId')
        .lean()
        .exec();
      for (const d of docs || []) {
        if (d?._id) out.add(String(d._id));
        if (d?.guestId) out.add(String(d.guestId));
      }
    }

    return out;
  } catch (e) {
    return new Set();
  }
};

// Returns a primary (best) id + a set of equivalent ids that should be treated as "the same user".
// This fixes mismatches between JWT payload id vs Mongo _id vs guestId.
const getAuthIdentity = async (req) => {
  const payload = getAuthPayload(req);
  if (!payload) return null;

  const ids = new Set();
  const add = (v) => {
    if (v === undefined || v === null) return;
    const s = String(v).trim();
    if (!s) return;
    ids.add(s);
  };

  add(payload.id);
  add(payload.userId);
  add(payload._id);
  add(payload.guestId);
  if (payload.email) add(String(payload.email).toLowerCase());

  // Expand from email -> user record
  try {
    const email = payload.email ? String(payload.email).toLowerCase() : null;
    if (email) {
      const u = await User.findOne({ email }).lean().catch(() => null);
      if (u) {
        add(u._id);
        add(u.guestId);
        if (u.email) add(String(u.email).toLowerCase());
      }
    }
  } catch (e) {}

  // Expand from payload.id to resolve guestId <-> _id
  try {
    if (payload.id) {
      const u = await User.findOne({ $or: [{ _id: String(payload.id) }, { guestId: String(payload.id) }] })
        .lean()
        .catch(() => null);
      if (u) {
        add(u._id);
        add(u.guestId);
        if (u.email) add(String(u.email).toLowerCase());
      }
    }
  } catch (e) {}

  const primary = (
    (payload.id ? String(payload.id) : null) ||
    (payload._id ? String(payload._id) : null) ||
    (payload.userId ? String(payload.userId) : null) ||
    (payload.guestId ? String(payload.guestId) : null) ||
    (payload.email ? String(payload.email).toLowerCase() : null)
  );

  return { payload, ids: Array.from(ids), primary };
};

const findMessageDocById = async (id) => {
  let doc = await RoomMessage.findById(id).catch(() => null);
  if (doc) return { doc, Model: RoomMessage };
  doc = await DMMessage.findById(id).catch(() => null);
  if (doc) return { doc, Model: DMMessage };
  doc = await RandomMessage.findById(id).catch(() => null);
  if (doc) return { doc, Model: RandomMessage };
  return { doc: null, Model: null };
};

router.get('/rooms/:roomId/messages', (req, res) => {
  const roomId = req.params.roomId;
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const key = `${ip}:${roomId}`;
  const now = Date.now();
  const effectiveMin = (env?.nodeEnv === 'production') ? MIN_INTERVAL_MS : 0;
  const last = lastMessageRequest.get(key) || 0;
  if (effectiveMin && (now - last < effectiveMin)) {
    // too many requests
    return res.status(429).json({ message: 'Too many requests' });
  }
  lastMessageRequest.set(key, now);

  // load from DB (most recent first or paginated)
  (async () => {
    try {
      const roomDoc = await Room.findById(roomId).lean().catch(() => null);
      const Model = getModelForRoom(roomDoc);
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
      const before = req.query.before; // cursor for pagination (messageId or timestamp)

      let query = { roomId };
      if (before) {
        // Fetch messages older than the cursor
        try {
          const cursorDoc = await Model.findById(before).lean();
          if (cursorDoc?.createdAt) {
            query.createdAt = { $lt: cursorDoc.createdAt };
          }
        } catch (e) {
          // If before is a timestamp instead of ID
          const ts = new Date(before);
          if (!isNaN(ts.getTime())) {
            query.createdAt = { $lt: ts };
          }
        }
      }

      let docs = await Model.find(query).sort({ createdAt: -1 }).limit(limit).lean();

      // identify current user (optional) and filter blocked users' messages
      const auth = await getAuthIdentity(req);
      const blockedSet = auth?.primary ? await getExpandedBlockedSetForAuth(auth) : new Set();
      if (blockedSet.size) {
        docs = (docs || []).filter((d) => !blockedSet.has(String(d.senderId)));
      }

      const currentUserIds = auth?.ids || [];
      if (currentUserIds.length) {
        docs = (docs || []).filter((d) => {
          const meta = d?.meta || {};
          const hiddenFor = Array.isArray(meta.hiddenFor) ? meta.hiddenFor.map(String) : [];
          if (!hiddenFor.length) return true;
          return !hiddenFor.some((id) => currentUserIds.includes(String(id)));
        });
      }

      const mapped = docs.reverse().map(d => {
        const meta = d.meta || {};
        let viewedEntry = null;
        if (currentUserIds.length && Array.isArray(meta.viewed)) {
          viewedEntry = meta.viewed.find(v => currentUserIds.includes(String(v.userId))) || null;
        }
        const expireAt = viewedEntry ? (viewedEntry.expireAt ? new Date(viewedEntry.expireAt).toISOString() : null) : null;
        const expiredForYou = expireAt ? (Date.now() > new Date(expireAt).getTime()) : false;
        return ({
          id: d._id.toString(),
          roomId: d.roomId,
          senderId: d.senderId,
          senderName: d.senderName,
          content: d.content,
          type: d.type,
          attachments: Array.isArray(d.attachments) ? d.attachments : [],
          replyTo: d.replyTo,
          timestamp: d.createdAt,
          editedAt: d.editedAt,
          reactions: Array.isArray(d.reactions) ? d.reactions : [],
          meta,
          viewedByCurrentUser: Boolean(viewedEntry),
          expireAt,
          expiredForCurrentUser: expiredForYou
        });
      });
      res.json(mapped);
    } catch (e) {
      // fallback to in-memory cache
      const list = messages.get(roomId) || [];
      res.json(list.slice(-(Number(req.query.limit) || 50)));
    }
  })();
});

// Hide a message for the current user ("delete for me")
router.post('/messages/:id/hide', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const { doc } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });

  const meta = doc.meta || {};
  meta.hiddenFor = Array.isArray(meta.hiddenFor) ? meta.hiddenFor : [];
  const exists = meta.hiddenFor.some((v) => String(v) === String(auth.primary));
  if (!exists) meta.hiddenFor.push(String(auth.primary));
  doc.meta = meta;
  await doc.save();

  res.json({ message: 'hidden', id: doc._id.toString() });
}));

// Clear all messages in a room for the current user ("clear for me")
router.post('/rooms/:roomId/messages/clear-for-me', asyncHandler(async (req, res) => {
  const roomId = req.params.roomId;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const roomDoc = await Room.findById(roomId).lean().catch(() => null);
  const Model = getModelForRoom(roomDoc);
  await Model.updateMany(
    { roomId },
    { $addToSet: { 'meta.hiddenFor': String(auth.primary) } }
  ).exec();

  res.json({ message: 'cleared', roomId });
}));

// DM receipts: receiver marks messages as delivered/read.
router.post('/rooms/:roomId/messages/mark-delivered', asyncHandler(async (req, res) => {
  const roomId = req.params.roomId;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const roomDoc = await Room.findById(roomId).lean().catch(() => null);
  if (!isDmRoomDoc(roomDoc)) return res.status(400).json({ message: 'Receipts supported only for DMs' });

  const receiptIds = normalizeReceiptIds(auth);
  if (!receiptIds.length) return res.json({ message: 'ok', updated: 0 });

  const messageIdsRaw = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
  const messageIds = messageIdsRaw.map(String).filter(Boolean).slice(0, 200);

  const selfIds = Array.from(new Set([String(auth.primary), ...(auth.ids || []).map(String)])).filter(Boolean);
  const Model = getModelForRoom(roomDoc);

  const query = {
    roomId: String(roomId),
    senderId: { $nin: selfIds },
    ...(messageIds.length ? { _id: { $in: messageIds } } : {})
  };

  const result = await Model.updateMany(
    query,
    { $addToSet: { 'meta.deliveredTo': { $each: receiptIds } } }
  ).exec();

  res.json({ message: 'ok', updated: result?.modifiedCount ?? result?.nModified ?? 0 });
}));

router.post('/rooms/:roomId/messages/mark-read', asyncHandler(async (req, res) => {
  const roomId = req.params.roomId;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const roomDoc = await Room.findById(roomId).lean().catch(() => null);
  if (!isDmRoomDoc(roomDoc)) return res.status(400).json({ message: 'Receipts supported only for DMs' });

  // Respect user setting to not send read receipts.
  try {
    const me = await User.findOne({ $or: [{ _id: String(auth.primary) }, { guestId: String(auth.primary) }] })
      .select('settings')
      .lean()
      .catch(() => null);
    if (me?.settings?.showReadReceipts === false) {
      return res.json({ message: 'disabled', updated: 0 });
    }
  } catch (e) {
    // best-effort
  }

  const receiptIds = normalizeReceiptIds(auth);
  if (!receiptIds.length) return res.json({ message: 'ok', updated: 0 });

  const messageIdsRaw = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
  const messageIds = messageIdsRaw.map(String).filter(Boolean).slice(0, 200);

  const selfIds = Array.from(new Set([String(auth.primary), ...(auth.ids || []).map(String)])).filter(Boolean);
  const Model = getModelForRoom(roomDoc);

  const query = {
    roomId: String(roomId),
    senderId: { $nin: selfIds },
    ...(messageIds.length ? { _id: { $in: messageIds } } : {})
  };

  const result = await Model.updateMany(
    query,
    { $addToSet: { 'meta.readBy': { $each: receiptIds } } }
  ).exec();

  res.json({ message: 'ok', updated: result?.modifiedCount ?? result?.nModified ?? 0 });
}));

router.post('/rooms/:roomId/messages', requireVerifiedForHighRisk, asyncHandler(async (req, res) => {
  const roomId = req.params.roomId;
  const { senderId, content, replyTo } = req.body || {};

  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  // Prevent spoofing senderId; if provided senderId isn't one of your equivalent ids, fall back to canonical id.
  const senderIdEffective = (senderId && auth.ids.includes(String(senderId))) ? String(senderId) : String(auth.primary);
  // word limit check
  const words = (content || '').trim().split(/\s+/).filter(Boolean).length;
  if (words > MAX_WORDS) {
    return res.status(400).json({ message: `Message too long (max ${MAX_WORDS} words)` });
  }

  // mute check
  if (isUserMuted(senderIdEffective)) {
    const until = mutedUsers.get(senderIdEffective);
    return res.status(403).json({ message: 'You are muted for spamming', mutedUntil: until });
  }

  // Check room-level bans/mutes (by userId or IP)
  try {
    const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '').toString().split(',')[0].trim();
    const roomDoc = await Room.findById(roomId).lean().catch(() => null);
    if (roomDoc) {
      // check direct userId ban
      if (Array.isArray(roomDoc.bannedUsers) && auth?.ids?.length) {
        const banned = auth.ids.some(id => roomDoc.bannedUsers.includes(id));
        if (banned) return res.status(403).json({ message: 'You are banned from this room' });
      }

      if (Array.isArray(roomDoc.bannedUsers) && senderIdEffective && roomDoc.bannedUsers.includes(senderIdEffective)) {
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
      if (Array.isArray(roomDoc.mutedUsers) && senderIdEffective) {
        const mu = roomDoc.mutedUsers.find(m => String(m.userId) === String(senderIdEffective) && new Date(m.until) > new Date());
        if (mu) return res.status(403).json({ message: 'You are muted in this room', mutedUntil: mu.until });
      }
      if (Array.isArray(roomDoc.mutedUsers) && auth?.ids?.length) {
        const mu = roomDoc.mutedUsers.find(m => auth.ids.includes(String(m.userId)) && new Date(m.until) > new Date());
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
  const muteStart = registerUserMessage(senderIdEffective);
  if (muteStart) {
    return res.status(403).json({ message: 'You have been muted for 5 minutes due to spam', mutedUntil: muteStart });
  }

  // persist to DB using correct model for the room
  const roomDoc = await Room.findById(roomId).lean().catch(() => null);

  // Block enforcement for DMs: if either side has blocked the other, do not allow sending.
  try {
    if (isDmRoomDoc(roomDoc)) {
      const participants = (roomDoc?.participants || roomDoc?.members || []).map(String).filter(Boolean);
      const other = participants.find((p) => !auth.ids.includes(String(p))) || null;
      if (other) {
        const senderBlocked = await getExpandedBlockedSetForUserId(senderIdEffective);
        const otherBlocked = await getExpandedBlockedSetForUserId(other);

        const senderIds = Array.from(new Set([String(senderIdEffective), ...(auth.ids || []).map(String)]));
        const either =
          senderBlocked.has(String(other)) ||
          senderIds.some((sid) => otherBlocked.has(String(sid)));
        if (either) {
          return res.status(403).json({ message: 'Cannot send DM: one of the users has blocked the other' });
        }
      }
    }
  } catch (e) {
    // best-effort
  }

  // Media in DMs requires friendship (image/voice/audio)
  try {
    if (isDmRoomDoc(roomDoc)) {
      const msgType = String((req.body && req.body.type) || 'text').toLowerCase();
      const isMedia = msgType === 'image' || msgType === 'audio' || msgType === 'voice' || msgType === 'media';
      if (isMedia) {
        const participants = (roomDoc?.participants || roomDoc?.members || []).map(String).filter(Boolean);
        const other = participants.find((p) => !auth.ids.includes(String(p))) || null;
        if (other) {
          const ok = await areUsersFriends(senderIdEffective, other);
          if (!ok) {
            return res.status(403).json({ message: 'Only friends can send images/voice notes in DMs' });
          }
        }
      }
    }
  } catch (e) {
    // best-effort
  }


  // Privacy enforcement for DMs: if the other user only allows friends to DM, require friendship.
  try {
    if (isDmRoomDoc(roomDoc)) {
      const participants = (roomDoc?.participants || roomDoc?.members || []).map(String).filter(Boolean);
      const other = participants.find((p) => !auth.ids.includes(String(p))) || null;
      if (other) {
        const otherDoc = await User.findOne({ $or: [{ _id: String(other) }, { guestId: String(other) }] })
          .select('settings friends')
          .lean()
          .catch(() => null);

        const dmScope = otherDoc?.settings?.privacy?.dmScope || 'everyone';
        if (dmScope === 'friends') {
          const friends = Array.isArray(otherDoc?.friends) ? otherDoc.friends.map(String).filter(Boolean) : [];
          const senderIds = Array.from(new Set([String(senderIdEffective), ...(auth.ids || []).map(String)]));
          const isFriend = senderIds.some((sid) => friends.includes(String(sid)));
          if (!isFriend) {
            return res.status(403).json({ message: 'Only friends can send private messages.' });
          }
        }
      }
    }
  } catch (e) {
    // best-effort
  }

  const Model = getModelForRoom(roomDoc);
  const safeAttachments = Array.isArray(req.body?.attachments)
    ? req.body.attachments.map(a => ({
        url: a?.url,
        fileName: a?.fileName,
        fileSize: a?.fileSize,
        mimeType: a?.mimeType,
        publicId: a?.publicId
      }))
    : [];

  const doc = new Model({
    roomId,
    senderId: senderIdEffective,
    senderName: req.body.senderName || '',
    content,
    type: req.body.type || 'text',
    replyTo: replyTo ? String(replyTo) : undefined,
    attachments: safeAttachments
  });
  await doc.save();
  // keep in-memory cache for quick reads (optional)
  try {
    const list = messages.get(roomId) || [];
    list.push({
      id: doc._id.toString(),
      roomId,
      senderId: doc.senderId,
      senderName: doc.senderName,
      content: doc.content,
      type: doc.type,
      attachments: Array.isArray(doc.attachments) ? doc.attachments : [],
      timestamp: doc.createdAt.toISOString(),
      replyTo: doc.replyTo
    });
    messages.set(roomId, list);
  } catch (e) {}
  res.json({
    id: doc._id.toString(),
    roomId,
    senderId: doc.senderId,
    senderName: doc.senderName,
    content: doc.content,
    type: doc.type,
    attachments: Array.isArray(doc.attachments) ? doc.attachments : [],
    timestamp: doc.createdAt.toISOString(),
    replyTo: doc.replyTo
  });
}));

router.patch('/messages/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const content = (req.body?.content ?? req.body?.message ?? '').toString();
  if (!content.trim()) return res.status(400).json({ message: 'content required' });

  const { doc } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });
  const allowed = auth.ids.includes(String(doc.senderId));
  if (!allowed) return res.status(403).json({ message: 'Forbidden' });

  if (doc?.meta && doc.meta.deleted) return res.status(400).json({ message: 'Message is deleted' });

  doc.content = content;
  doc.editedAt = new Date();
  await doc.save();
  res.json({ id: doc._id.toString(), roomId: doc.roomId, senderId: doc.senderId, senderName: doc.senderName, content: doc.content, type: doc.type, replyTo: doc.replyTo, timestamp: doc.createdAt, editedAt: doc.editedAt, reactions: Array.isArray(doc.reactions) ? doc.reactions : [], meta: doc.meta || {} });
}));

router.delete('/messages/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const { doc, Model } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });
  const isSender = auth.ids.includes(String(doc.senderId));

  let isModerator = false;
  try {
    const roomDoc = await Room.findById(String(doc.roomId)).select('owner admins type category').lean().catch(() => null);
    if (roomDoc && !isDmRoomDoc(roomDoc)) {
      const ownerId = roomDoc.owner ? String(roomDoc.owner) : null;
      const adminIds = Array.isArray(roomDoc.admins) ? roomDoc.admins.map(String) : [];
      isModerator = (ownerId && auth.ids.includes(ownerId)) || adminIds.some((a) => auth.ids.includes(String(a)));
    }
  } catch (e) {}

  if (!isSender && !isModerator) return res.status(403).json({ message: 'Forbidden' });

  // For DM rooms: soft-delete so both sides see "Message deleted" (instead of disappearing).
  try {
    const roomDoc = await Room.findById(String(doc.roomId)).lean().catch(() => null);
    const isDmByModel = Boolean(Model && DMMessage && Model === DMMessage);
    if (isDmByModel || isDmRoomDoc(roomDoc)) {
      const meta = doc.meta || {};
      meta.deleted = true;
      meta.deletedAt = new Date();
      meta.deletedBy = String(auth.primary);
      doc.meta = meta;
      doc.content = '';
      await doc.save();

      // Best-effort: keep in-memory cache consistent if it exists
      try {
        const list = messages.get(String(doc.roomId)) || [];
        const idx = list.findIndex(m => String(m.id) === String(id));
        if (idx !== -1) {
          list[idx] = { ...list[idx], content: '', meta: { ...(list[idx].meta || {}), deleted: true, deletedAt: meta.deletedAt, deletedBy: meta.deletedBy } };
          messages.set(String(doc.roomId), list);
        }
      } catch (e) {}

      return res.json({ message: 'deleted', id, soft: true });
    }
  } catch (e) {
    // fall through to hard-delete
  }

  await Model.deleteOne({ _id: doc._id });
  res.json({ message: 'deleted', id, soft: false });
}));

router.post('/messages/:id/reactions', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const emoji = (req.body?.emoji || '').toString();
  if (!emoji) return res.status(400).json({ message: 'emoji required' });

  const { doc } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });

  doc.reactions = Array.isArray(doc.reactions) ? doc.reactions : [];
  const exists = doc.reactions.find(r => String(r.emoji) === emoji && auth.ids.includes(String(r.userId)));
  if (!exists) {
    doc.reactions.push({ emoji, userId: String(auth.primary), createdAt: new Date() });
    await doc.save();
  }

  res.json({ message: 'reaction added', id: doc._id.toString(), reactions: Array.isArray(doc.reactions) ? doc.reactions : [] });
}));

router.delete('/messages/:id/reactions', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const emoji = (req.query?.emoji || '').toString();
  if (!emoji) return res.status(400).json({ message: 'emoji required' });

  const { doc } = await findMessageDocById(id);
  if (!doc) return res.status(404).json({ message: 'Message not found' });

  doc.reactions = Array.isArray(doc.reactions) ? doc.reactions : [];
  doc.reactions = doc.reactions.filter(r => !(String(r.emoji) === emoji && auth.ids.includes(String(r.userId))));
  await doc.save();

  res.json({ message: 'reaction removed', id: doc._id.toString(), reactions: Array.isArray(doc.reactions) ? doc.reactions : [] });
}));

// Mark a message as viewed by the current user (one-time preview per user)
router.post('/messages/:id/view', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  // Try to find the message in any of the collections
  let doc = await RoomMessage.findById(id).catch(() => null);
  if (!doc) doc = await DMMessage.findById(id).catch(() => null);
  if (!doc) doc = await RandomMessage.findById(id).catch(() => null);
  if (!doc) return res.status(404).json({ message: 'Message not found' });

  const meta = doc.meta || {};
  meta.viewed = Array.isArray(meta.viewed) ? meta.viewed : [];
  const existing = meta.viewed.find(v => auth.ids.includes(String(v.userId)));
  const now = new Date();
  if (!existing) {
    meta.viewed.push({ userId: String(auth.primary), viewedAt: now, expireAt: null });
  }
  doc.meta = meta;
  await doc.save();
  res.json({ message: 'view recorded', alreadyViewed: Boolean(existing) });
}));

export default router;
