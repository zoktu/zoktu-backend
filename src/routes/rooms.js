import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import Room from '../models/Room.js';
import { users, upsertUserInMemory } from '../lib/userStore.js';
import User from '../models/User.js';
import requireVerifiedForHighRisk from '../middleware/riskGuard.js';

const router = Router();
const rooms = new Map();
// Simple in-memory waiting queue for random chat pairing
const waitingQueue = [];

const BOT_ID = env.botId || 'bot-baka';
const BOT_NAME = env.botName || 'Baka';
const BOT_ENABLED = Boolean(env.geminiApiKey) && (String(env.botEnabled || '').toLowerCase() !== 'false');

const ensureBotUser = async () => {
  if (!BOT_ENABLED) return null;
  try {
    const existing = await User.findOne({ guestId: String(BOT_ID) }).lean().catch(() => null);
    if (existing) return upsertUserInMemory({ ...existing, id: String(existing.guestId || existing._id) });
    const doc = await User.findOneAndUpdate(
      { guestId: String(BOT_ID) },
      {
        $setOnInsert: {
          guestId: String(BOT_ID),
          userType: 'guest',
          displayName: String(BOT_NAME),
          name: String(BOT_NAME),
          username: String(BOT_NAME)
        },
        $set: {
          displayName: String(BOT_NAME),
          name: String(BOT_NAME),
          username: String(BOT_NAME),
          isOnline: true
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean().exec();
    if (!doc) return null;
    return upsertUserInMemory({ ...doc, id: String(doc.guestId || doc._id) });
  } catch (e) {
    return null;
  }
};

const uniqStrings = (arr) => Array.from(new Set((arr || []).filter(Boolean).map((v) => String(v))));

const buildDmKey = (participants) => {
  const list = Array.isArray(participants) ? participants.map(String).filter(Boolean) : [];
  if (list.length < 2) return null;
  // For DMs, order shouldn't matter
  return list.slice().sort().join('|');
};

const buildCanonicalDmKey = (participants, canonicalById) => {
  const list = Array.isArray(participants) ? participants.map(String).filter(Boolean) : [];
  if (list.length < 2) return null;
  const canonical = list.map((id) => canonicalById.get(String(id)) || String(id));
  const uniq = Array.from(new Set(canonical.filter(Boolean)));
  // If both sides resolve to the same user, treat it as invalid (self-DM)
  if (uniq.length < 2) return null;
  return canonical.slice().sort().join('|');
};

const isDmRoomDoc = (doc) => Boolean(
  doc && (
    doc.type === 'dm' ||
    doc.category === 'dm' ||
    (doc.type === 'private' && doc.category === 'dm')
  )
);

const expandUserIdentifiers = async ({ id, email }) => {
  const ids = new Set();
  if (id) ids.add(String(id));

  try {
    if (email) {
      const uByEmail = await User.findOne({ email: String(email) }).select('_id guestId userType').lean().catch(() => null);
      if (uByEmail?._id) ids.add(String(uByEmail._id));
      if (uByEmail?.guestId) ids.add(String(uByEmail.guestId));
    }
  } catch (e) {}

  try {
    if (id) {
      const u = await User.findOne({ $or: [{ _id: String(id) }, { guestId: String(id) }] }).select('_id guestId userType').lean().catch(() => null);
      if (u?._id) ids.add(String(u._id));
      if (u?.guestId) ids.add(String(u.guestId));
    }
  } catch (e) {}

  return Array.from(ids);
};

const canonicalIdForUser = async (id) => {
  if (!id) return null;
  try {
    const u = await User.findOne({ $or: [{ _id: String(id) }, { guestId: String(id) }] }).select('_id guestId userType').lean().catch(() => null);
    if (!u) return String(id);
    if (u.userType === 'guest' && u.guestId) return String(u.guestId);
    if (u._id) return String(u._id);
    return String(id);
  } catch (e) {
    return String(id);
  }
};

const canonicalIdForAuthPayload = async (payload) => {
  if (!payload) return null;

  // Prefer resolving registered users by email because JWT payload.id may be a legacy in-memory id.
  try {
    if (payload.email) {
      const u = await User.findOne({ email: String(payload.email) }).select('_id guestId userType').lean().catch(() => null);
      if (u) {
        if (u.userType === 'guest' && u.guestId) return String(u.guestId);
        if (u._id) return String(u._id);
      }
    }
  } catch (e) {}

  return canonicalIdForUser(payload.id);
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

    // Expand to include both _id and guestId forms for each blocked user.
    const objectIdCandidates = raw.filter((v) => /^[0-9a-fA-F]{24}$/.test(String(v)));
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

const isBlockedEitherWay = async ({ aId, aIds, bId, bIds }) => {
  const aSet = new Set(uniqStrings(aIds || [aId]));
  const bSet = new Set(uniqStrings(bIds || [bId]));

  const aBlocked = await getExpandedBlockedSetForUserId(aId);
  for (const bid of bSet) {
    if (aBlocked.has(String(bid))) return true;
  }

  const bBlocked = await getExpandedBlockedSetForUserId(bId);
  for (const aid of aSet) {
    if (bBlocked.has(String(aid))) return true;
  }

  return false;
};

router.get('/', asyncHandler(async (req, res) => {
  // prefer DB-backed list but fall back to in-memory
  try {
    const { type, member } = req.query || {};
    const and = [];
    if (type) and.push({ type: String(type) });
    if (member) {
      const m = String(member);

      // Hide rooms removed by this user (supports canonical/guestId variants)
      let expandedMemberIds = [m];
      try {
        const or = [];
        if (/^[0-9a-fA-F]{24}$/.test(m)) or.push({ _id: m });
        or.push({ guestId: m });
        or.push({ email: m });
        const u = await User.findOne(or.length ? { $or: or } : { guestId: m }).select('_id guestId').lean().catch(() => null);
        if (u?._id) expandedMemberIds.push(String(u._id));
        if (u?.guestId) expandedMemberIds.push(String(u.guestId));
      } catch (e) {}
      expandedMemberIds = uniqStrings(expandedMemberIds);

      // list only rooms the user belongs to (DMs/private/public membership)
      and.push({ $or: [{ members: m }, { participants: m }, { owner: m }, { createdBy: m }] });

      // exclude rooms hidden by this user
      and.push({ hiddenFor: { $nin: expandedMemberIds } });
    }
    const match = and.length ? { $and: and } : {};

    // Use aggregation to compute member count and sort by it (desc)
    const pipeline = [
      { $match: match },
      { $addFields: { memberCount: { $size: { $ifNull: ["$members", []] } } } },
      { $sort: { memberCount: -1, updatedAt: -1 } }
    ];
    const docs = await Room.aggregate(pipeline).allowDiskUse(true).exec();

    // De-dupe DMs: only one conversation per participant-pair
    // Canonicalize ids so guestId vs Mongo _id variants collapse.
    const dmDocs = (docs || []).filter((d) => isDmRoomDoc(d));
    const candidateIds = [];
    for (const d of dmDocs) {
      const list = (d.participants || d.members || []).map(String).filter(Boolean);
      for (const id of list) candidateIds.push(id);
    }
    const uniqueCandidateIds = Array.from(new Set(candidateIds));
    const objectIdCandidates = uniqueCandidateIds.filter((v) => /^[0-9a-fA-F]{24}$/.test(String(v)));
    const guestIdCandidates = uniqueCandidateIds.filter((v) => String(v).startsWith('guest-'));

    const canonicalById = new Map();
    try {
      const userDocs = await User.find({
        $or: [
          ...(objectIdCandidates.length ? [{ _id: { $in: objectIdCandidates } }] : []),
          ...(guestIdCandidates.length ? [{ guestId: { $in: guestIdCandidates } }] : [])
        ]
      })
        .select('_id guestId userType')
        .lean()
        .exec();

      for (const u of userDocs || []) {
        const canonical = (u.userType === 'guest' && u.guestId) ? String(u.guestId) : String(u._id);
        canonicalById.set(String(u._id), canonical);
        if (u.guestId) canonicalById.set(String(u.guestId), canonical);
      }
    } catch (e) {
      // best-effort
    }

    const seenDm = new Set();
    const filtered = [];
    for (const d of docs || []) {
      if (isDmRoomDoc(d)) {
        const key = buildCanonicalDmKey(d.participants || d.members, canonicalById) || buildDmKey(d.participants || d.members);
        if (key) {
          if (seenDm.has(key)) continue;
          seenDm.add(key);
        }
      }
      filtered.push(d);
    }

    const mapped = filtered.map(d => ({ id: d._id, ...d }));
    res.json(mapped);
    return;
  } catch (e) {
    // in-memory fallback with the same filters
    const { type, member } = req.query || {};
    const t = type ? String(type) : null;
    const m = member ? String(member) : null;
    const filtered = Array.from(rooms.values()).filter((r) => {
      if (t && String(r.type) !== t) return false;
      if (m) {
        // hide rooms removed by this user
        try {
          const hiddenFor = Array.isArray(r.hiddenFor) ? r.hiddenFor.map(String) : [];
          if (hiddenFor.includes(String(m))) return false;
        } catch (e) {}
        const list = (r.members || r.participants || []);
        if (Array.isArray(list) && list.map(String).includes(m)) return true;
        if (String(r.owner) === m) return true;
        if (String(r.createdBy) === m) return true;
        return false;
      }
      return true;
    });

    // De-dupe DMs in-memory as well
    const seenDm = new Set();
    const deduped = [];
    for (const r of filtered) {
      const isDm = Boolean(r && (r.type === 'dm' || r.category === 'dm' || (r.type === 'private' && r.category === 'dm')));
      if (isDm) {
        const key = buildDmKey(r.participants || r.members);
        if (key) {
          if (seenDm.has(key)) continue;
          seenDm.add(key);
        }
      }
      deduped.push(r);
    }

    res.json(deduped);
  }
}));

// Hide a room for the requester only (DM sidebar "X" behavior)
router.post('/:id/hide', asyncHandler(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (e) {
    return res.status(401).json({ message: 'Invalid token' });
  }

  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ message: 'Invalid room id' });

  let roomDoc = null;
  try { roomDoc = await Room.findById(id).lean().catch(() => null); } catch (e) {}
  const inMemory = rooms.get(id) || null;
  if (!roomDoc && !inMemory) return res.status(404).json({ message: 'Room not found' });

  const requesterExpanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const canonical = (await canonicalIdForAuthPayload(payload)) || (payload?.id ? String(payload.id) : null);
  if (!canonical) return res.status(401).json({ message: 'Unauthorized' });

  const doc = roomDoc || inMemory;
  const participants = (doc && (doc.participants || doc.members)) || [];
  const participantSet = new Set(Array.isArray(participants) ? participants.map(String) : []);
  const isMember = requesterExpanded.some((rid) => participantSet.has(String(rid))) || participantSet.has(String(canonical));
  if (!isMember) return res.status(403).json({ message: 'You are not a member of this room' });

  try {
    await Room.findByIdAndUpdate(
      id,
      { $addToSet: { hiddenFor: String(canonical) }, $set: { updatedAt: new Date() } },
      { upsert: false }
    ).lean();
  } catch (e) {
    // best-effort
  }

  try {
    const mem = rooms.get(id);
    if (mem) {
      const hiddenFor = Array.isArray(mem.hiddenFor) ? mem.hiddenFor.map(String) : [];
      if (!hiddenFor.includes(String(canonical))) hiddenFor.push(String(canonical));
      mem.hiddenFor = hiddenFor;
      rooms.set(id, mem);
    }
  } catch (e) {}

  res.json({ message: 'Room hidden' });
}));

router.post('/', asyncHandler(async (req, res) => {
  // Require authenticated registered user to create a room
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (e) {
    return res.status(401).json({ message: 'Invalid token' });
  }

  // Resolve the latest user record so we don't rely solely on a potentially stale JWT payload.
  let userRecord = null;
  if (payload?.email && users.has(payload.email)) {
    userRecord = users.get(payload.email);
  }
  if (!userRecord && payload?.id && users.has(payload.id)) {
    userRecord = users.get(payload.id);
  }
  if (!userRecord && payload?.id) {
    // Fallback to DB lookup using multiple identifiers (id, guestId, email)
    try {
      const id = String(payload.id);
      const email = payload.email ? String(payload.email) : null;
      const or = [{ _id: id }, { guestId: id }];
      if (email) or.push({ email });
      userRecord = await User.findOne({ $or: or }).lean().exec();
    } catch (e) {}
  }

  const effectiveUserType = (userRecord && userRecord.userType) || payload?.userType;
  if (!effectiveUserType || effectiveUserType !== 'registered') {
    return res.status(403).json({ message: 'Only registered users can create rooms' });
  }

  // Require email-verified for room creation
  const emailVerified = Boolean(userRecord && (userRecord.emailVerified || userRecord.emailVerified === true));
  if (!emailVerified) {
    return res.status(403).json({ message: 'Only email-verified registered users can create rooms' });
  }

  const id = `room-${Date.now()}`;
  const ownerId = payload.id;
  const room = {
    id,
    ...req.body,
    owner: ownerId,
    createdBy: ownerId,
    participants: Array.from(new Set([ownerId, ...(req.body.participants || [])]))
  };
  // persist to DB
  try {
    const doc = new Room({ _id: id, name: room.name || '', description: room.description || '', type: room.type || 'public', owner: ownerId, createdBy: ownerId, participants: room.participants, members: room.members || room.participants, settings: room.settings || {}, category: room.category || '' });
    await doc.save();
  } catch (e) {
    // ignore persistence errors but keep in-memory
    console.warn('Could not persist room to DB', e?.message || e);
  }
  rooms.set(id, room);
  res.json(room);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  // try DB first
  try {
    const doc = await Room.findById(id).lean();
    if (doc) return res.json({ id: doc._id, ...doc });
  } catch (e) {}
  const room = rooms.get(id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  res.json(room);
}));

router.post('/:id/join', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const userId = req.body.userId;
  if (!userId) return res.status(400).json({ message: 'userId required' });

  // Prefer DB-backed join so it survives restarts; fall back to in-memory.
  let roomDoc = null;
  try { roomDoc = await Room.findById(id).lean().catch(() => null); } catch (e) {}

  const roomMem = rooms.get(id) || null;
  if (!roomDoc && !roomMem) return res.status(404).json({ message: 'Room not found' });

  const roomForBot = roomDoc || roomMem;
  const shouldAddBot = BOT_ENABLED && roomForBot && !isDmRoomDoc(roomForBot) && ['public', 'private'].includes(String(roomForBot.type || ''));
  if (shouldAddBot) {
    await ensureBotUser();
  }

  // enforce bans using DB doc if present
  try {
    const doc = roomDoc;
    const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '').toString().split(',')[0].trim();
    if (doc) {
      // check direct userId ban
      if (Array.isArray(doc.bannedUsers) && doc.bannedUsers.includes(userId)) {
        return res.status(403).json({ message: 'You are banned from this room' });
      }
      // also check linked guestId for this user (if any)
      try {
        const u = await User.findOne({ $or: [{ _id: String(userId) }, { guestId: String(userId) }] }).select('guestId').lean().catch(() => null);
        if (u && u.guestId && Array.isArray(doc.bannedUsers) && doc.bannedUsers.includes(u.guestId)) {
          return res.status(403).json({ message: 'You are banned from this room' });
        }
      } catch (e) {}
      if (Array.isArray(doc.bannedIPs) && ip && doc.bannedIPs.includes(ip)) {
        return res.status(403).json({ message: 'Your IP is banned from this room' });
      }
    }
  } catch (e) {}

  // Update DB if present
  if (roomDoc) {
    try {
      const addParticipants = shouldAddBot
        ? { $each: [String(userId), String(BOT_ID)] }
        : String(userId);
      await Room.findByIdAndUpdate(
        id,
        { $addToSet: { participants: addParticipants, members: addParticipants }, $set: { updatedAt: new Date() } },
        { upsert: false }
      );
      const fresh = await Room.findById(id).lean().catch(() => null);
      if (fresh) {
        // keep cache lightly in sync
        try { rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh }); } catch (e) {}
        return res.json({ id: fresh._id, ...fresh });
      }
    } catch (e) {
      console.warn('Failed to update DB for join:', e?.message || e);
    }
  }

  // in-memory fallback
  const next = roomMem || { id, ...(roomDoc || {}) };
  next.participants = [...new Set([...(next.participants || []), String(userId)])];
  next.members = [...new Set([...(next.members || []), String(userId)])];
  if (shouldAddBot) {
    next.participants = [...new Set([...(next.participants || []), String(BOT_ID)])];
    next.members = [...new Set([...(next.members || []), String(BOT_ID)])];
  }
  rooms.set(id, next);
  res.json(next);
}));

// Allow room creator/owner to delete a room (permanent removal)
router.delete('/:id', asyncHandler(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (e) {
    return res.status(401).json({ message: 'Invalid token' });
  }

  const id = req.params.id;
  // verify room exists
  let roomDoc = null;
  try { roomDoc = await Room.findById(id).lean(); } catch (e) {}
  if (!roomDoc) {
    // also check in-memory
    if (!rooms.has(id)) return res.status(404).json({ message: 'Room not found' });
  }

  // only creator/owner can delete (except DM rooms where participants can delete)
  // NOTE: user identifiers can be inconsistent across restarts (in-memory id vs Mongo _id vs guestId).
  // Build a set of equivalent requester identifiers and accept a match on any.
  const requesterIds = new Set();
  if (payload?.id) requesterIds.add(String(payload.id));

  try {
    if (payload?.email) {
      const uByEmail = await User.findOne({ email: String(payload.email) }).select('_id guestId').lean().catch(() => null);
      if (uByEmail?._id) requesterIds.add(String(uByEmail._id));
      if (uByEmail?.guestId) requesterIds.add(String(uByEmail.guestId));
    }
  } catch (e) {}

  try {
    if (payload?.id) {
      // if payload.id is a Mongo _id OR a guestId, resolve and add both representations
      const u = await User.findOne({ $or: [{ _id: String(payload.id) }, { guestId: String(payload.id) }] })
        .select('_id guestId')
        .lean()
        .catch(() => null);
      if (u?._id) requesterIds.add(String(u._id));
      if (u?.guestId) requesterIds.add(String(u.guestId));
    }
  } catch (e) {}

  const ownerId = roomDoc ? (roomDoc.createdBy || roomDoc.owner) : null;
  const isDmRoom = Boolean(
    roomDoc && (
      roomDoc.type === 'dm' ||
      roomDoc.category === 'dm' ||
      (roomDoc.type === 'private' && roomDoc.category === 'dm')
    )
  );
  const participants = (roomDoc && (roomDoc.participants || roomDoc.members)) || [];
  const participantSet = new Set(Array.isArray(participants) ? participants.map(String) : []);
  const isParticipant = Array.from(requesterIds).some((rid) => participantSet.has(String(rid)));
  const isOwner = ownerId ? Array.from(requesterIds).some((rid) => String(ownerId) === String(rid)) : false;

  if (isDmRoom) {
    if (!isParticipant) return res.status(403).json({ message: 'Only DM participants can delete this conversation' });
  } else {
    if (ownerId && !isOwner) return res.status(403).json({ message: 'Only room owner can delete this room' });
  }

  try {
    if (roomDoc) await Room.deleteOne({ _id: id });
  } catch (e) {
    console.warn('Failed to delete room from DB', e?.message || e);
  }
  // remove from in-memory map as well
  rooms.delete(id);
  res.json({ message: 'Room deleted' });
}));

// Ban a user or IP from a room (owner/admin only)
router.post('/:id/ban', asyncHandler(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  let payload;
  try { payload = jwt.verify(token, env.jwtSecret); } catch (e) { return res.status(401).json({ message: 'Invalid token' }); }

  const id = req.params.id;
  const { targetUserId, ip, banIp } = req.body || {};
  const roomDoc = await Room.findById(id).lean().catch(() => null);
  if (!roomDoc && !rooms.has(id)) return res.status(404).json({ message: 'Room not found' });

  const requesterExpanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const requesterSet = new Set(uniqStrings(requesterExpanded));
  const requesterCanonical = (await canonicalIdForAuthPayload(payload)) || (payload?.id ? String(payload.id) : null);
  if (requesterCanonical) requesterSet.add(String(requesterCanonical));

  const ownerId = roomDoc?.owner || roomDoc?.createdBy || null;
  const admins = Array.isArray(roomDoc?.admins) ? roomDoc.admins.map(String) : [];
  const isOwner = ownerId ? Array.from(requesterSet).some((rid) => String(ownerId) === String(rid)) : false;
  const isAdmin = admins.length ? Array.from(requesterSet).some((rid) => admins.includes(String(rid))) : false;
  if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Only owner or admins can ban users' });

  try {
    // build comprehensive ban lists: include target id, their guestId, and other accounts sharing lastIp
    const bannedIds = [];
    if (targetUserId) bannedIds.push(targetUserId);
    try {
      const target = targetUserId ? await User.findById(targetUserId).lean().catch(() => null) : null;
      const ipToBan = ip || (target && target.lastIp) || null;
      if (target && target.guestId) bannedIds.push(target.guestId);

      // find other users sharing same IP and include their ids/guestIds as well
      if (ipToBan) {
        try {
          const sameIpUsers = await User.find({ lastIp: ipToBan }).select(' _id guestId ').lean().catch(() => []);
          for (const u of sameIpUsers || []) {
            if (u._id) bannedIds.push(String(u._id));
            if (u.guestId) bannedIds.push(u.guestId);
          }
        } catch (e) {}
      }

      // dedupe
      const uniqueBannedIds = Array.from(new Set(bannedIds.filter(Boolean)));
      const bannedIpList = ipToBan ? [ipToBan] : (banIp && ip ? [ip] : []);

      const updateObj = {};
      if (uniqueBannedIds.length) updateObj.$addToSet = { bannedUsers: { $each: uniqueBannedIds } };
      if (bannedIpList.length) updateObj.$addToSet = Object.assign(updateObj.$addToSet || {}, { bannedIPs: { $each: bannedIpList } });

      if (Object.keys(updateObj).length) {
        await Room.findByIdAndUpdate(id, updateObj, { upsert: false }).catch(() => null);
      }

      try {
        const fresh = await Room.findById(id).lean().catch(() => null);
        if (fresh) {
          rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh });
        }
      } catch (e) {}

      return res.json({ message: 'Banned', targets: uniqueBannedIds, ips: bannedIpList });
    } catch (e) {
      console.warn('Ban flow failure', e?.message || e);
      return res.status(500).json({ message: 'Failed to ban' });
    }
  } catch (e) {
    console.warn('Ban failed', e?.message || e);
    return res.status(500).json({ message: 'Failed to ban' });
  }
}));

// Mute a user or IP for a duration (owner/admin only)
router.post('/:id/mute', asyncHandler(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  let payload;
  try { payload = jwt.verify(token, env.jwtSecret); } catch (e) { return res.status(401).json({ message: 'Invalid token' }); }

  const id = req.params.id;
  const { targetUserId, ip, durationMs } = req.body || {};
  const roomDoc = await Room.findById(id).lean().catch(() => null);
  if (!roomDoc && !rooms.has(id)) return res.status(404).json({ message: 'Room not found' });

  const requesterExpanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const requesterSet = new Set(uniqStrings(requesterExpanded));
  const requesterCanonical = (await canonicalIdForAuthPayload(payload)) || (payload?.id ? String(payload.id) : null);
  if (requesterCanonical) requesterSet.add(String(requesterCanonical));

  const ownerId = roomDoc?.owner || roomDoc?.createdBy || null;
  const admins = Array.isArray(roomDoc?.admins) ? roomDoc.admins.map(String) : [];
  const isOwner = ownerId ? Array.from(requesterSet).some((rid) => String(ownerId) === String(rid)) : false;
  const isAdmin = admins.length ? Array.from(requesterSet).some((rid) => admins.includes(String(rid))) : false;
  if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Only owner or admins can mute users' });

  const until = new Date(Date.now() + (Number(durationMs) || (5 * 60 * 1000)));
  try {
    if (targetUserId) {
      await Room.findByIdAndUpdate(id, { $push: { mutedUsers: { userId: targetUserId, until } } }).catch(() => null);
    }
    if (ip) {
      await Room.findByIdAndUpdate(id, { $push: { mutedIPs: { ip, until } } }).catch(() => null);
    }

    try {
      const fresh = await Room.findById(id).lean().catch(() => null);
      if (fresh) {
        rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh });
      }
    } catch (e) {}
    return res.json({ message: 'Muted', targetUserId, ip, until });
  } catch (e) {
    console.warn('Mute failed', e?.message || e);
    return res.status(500).json({ message: 'Failed to mute' });
  }
}));

// Unban a user or IP from a room (owner/admin only)
router.post('/:id/unban', asyncHandler(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  let payload;
  try { payload = jwt.verify(token, env.jwtSecret); } catch (e) { return res.status(401).json({ message: 'Invalid token' }); }

  const id = req.params.id;
  const { targetUserId, ip } = req.body || {};
  const roomDoc = await Room.findById(id).lean().catch(() => null);
  if (!roomDoc && !rooms.has(id)) return res.status(404).json({ message: 'Room not found' });

  const requesterExpanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const requesterSet = new Set(uniqStrings(requesterExpanded));
  const requesterCanonical = (await canonicalIdForAuthPayload(payload)) || (payload?.id ? String(payload.id) : null);
  if (requesterCanonical) requesterSet.add(String(requesterCanonical));

  const ownerId = roomDoc?.owner || roomDoc?.createdBy || null;
  const admins = Array.isArray(roomDoc?.admins) ? roomDoc.admins.map(String) : [];
  const isOwner = ownerId ? Array.from(requesterSet).some((rid) => String(ownerId) === String(rid)) : false;
  const isAdmin = admins.length ? Array.from(requesterSet).some((rid) => admins.includes(String(rid))) : false;
  if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Only owner or admins can unban users' });

  const updateObj = {};
  if (targetUserId) updateObj.$pull = { bannedUsers: String(targetUserId) };
  if (ip) updateObj.$pull = Object.assign(updateObj.$pull || {}, { bannedIPs: String(ip) });

  if (!Object.keys(updateObj).length) return res.status(400).json({ message: 'targetUserId or ip required' });

  try {
    await Room.findByIdAndUpdate(id, updateObj, { upsert: false }).catch(() => null);
    const fresh = await Room.findById(id).lean().catch(() => null);
    if (fresh) {
      rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh });
    }
    return res.json({ message: 'Unbanned', targetUserId, ip });
  } catch (e) {
    console.warn('Unban failed', e?.message || e);
    return res.status(500).json({ message: 'Failed to unban' });
  }
}));

// Unmute a user or IP from a room (owner/admin only)
router.post('/:id/unmute', asyncHandler(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  let payload;
  try { payload = jwt.verify(token, env.jwtSecret); } catch (e) { return res.status(401).json({ message: 'Invalid token' }); }

  const id = req.params.id;
  const { targetUserId, ip } = req.body || {};
  const roomDoc = await Room.findById(id).lean().catch(() => null);
  if (!roomDoc && !rooms.has(id)) return res.status(404).json({ message: 'Room not found' });

  const requesterExpanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const requesterSet = new Set(uniqStrings(requesterExpanded));
  const requesterCanonical = (await canonicalIdForAuthPayload(payload)) || (payload?.id ? String(payload.id) : null);
  if (requesterCanonical) requesterSet.add(String(requesterCanonical));

  const ownerId = roomDoc?.owner || roomDoc?.createdBy || null;
  const admins = Array.isArray(roomDoc?.admins) ? roomDoc.admins.map(String) : [];
  const isOwner = ownerId ? Array.from(requesterSet).some((rid) => String(ownerId) === String(rid)) : false;
  const isAdmin = admins.length ? Array.from(requesterSet).some((rid) => admins.includes(String(rid))) : false;
  if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Only owner or admins can unmute users' });

  const updateObj = {};
  if (targetUserId) updateObj.$pull = { mutedUsers: { userId: String(targetUserId) } };
  if (ip) updateObj.$pull = Object.assign(updateObj.$pull || {}, { mutedIPs: { ip: String(ip) } });

  if (!Object.keys(updateObj).length) return res.status(400).json({ message: 'targetUserId or ip required' });

  try {
    await Room.findByIdAndUpdate(id, updateObj, { upsert: false }).catch(() => null);
    const fresh = await Room.findById(id).lean().catch(() => null);
    if (fresh) {
      rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh });
    }
    return res.json({ message: 'Unmuted', targetUserId, ip });
  } catch (e) {
    console.warn('Unmute failed', e?.message || e);
    return res.status(500).json({ message: 'Failed to unmute' });
  }
}));

router.post('/:id/leave', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const userId = req.body.userId;
  if (!userId) return res.status(400).json({ message: 'userId required' });

  // Prefer DB-backed leave so it survives restarts; fall back to in-memory.
  let roomDoc = null;
  try { roomDoc = await Room.findById(id).lean().catch(() => null); } catch (e) {}
  const roomMem = rooms.get(id) || null;
  if (!roomDoc && !roomMem) return res.status(404).json({ message: 'Room not found' });

  if (roomDoc) {
    try {
      await Room.findByIdAndUpdate(
        id,
        { $pull: { participants: String(userId), members: String(userId) }, $set: { updatedAt: new Date() } },
        { upsert: false }
      );
      const fresh = await Room.findById(id).lean().catch(() => null);
      if (fresh) {
        try { rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh }); } catch (e) {}
        return res.json({ id: fresh._id, ...fresh });
      }
    } catch (e) {
      console.warn('Failed to update DB for leave:', e?.message || e);
    }
  }

  // in-memory fallback
  const next = roomMem || { id, ...(roomDoc || {}) };
  next.participants = (next.participants || []).map(String).filter(pid => pid !== String(userId));
  next.members = (next.members || []).map(String).filter(mid => mid !== String(userId));
  rooms.set(id, next);
  res.json(next);
}));

// Update room settings / metadata
router.patch('/:id', asyncHandler(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  let payload;
  try { payload = jwt.verify(token, env.jwtSecret); } catch (e) { return res.status(401).json({ message: 'Invalid token' }); }

  const id = req.params.id;
  const updates = req.body || {};

  // Only allow certain fields to be updated
  const allowed = ['name', 'description', 'category', 'settings', 'admins', 'members', 'isActive'];
  const setObj = {};
  for (const k of Object.keys(updates)) {
    if (allowed.includes(k)) setObj[k] = updates[k];
  }

  try {
    const roomDoc = await Room.findById(id).lean();
    if (!roomDoc) return res.status(404).json({ message: 'Room not found' });

    const requesterExpanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
    const requesterSet = new Set(uniqStrings(requesterExpanded));
    const requesterCanonical = (await canonicalIdForAuthPayload(payload)) || (payload?.id ? String(payload.id) : null);
    if (requesterCanonical) requesterSet.add(String(requesterCanonical));

    const ownerId = roomDoc.createdBy || roomDoc.owner;
    const admins = Array.isArray(roomDoc.admins) ? roomDoc.admins.map(String).filter(Boolean) : [];

    const isOwner = ownerId ? Array.from(requesterSet).some((rid) => String(ownerId) === String(rid)) : false;
    const isAdmin = admins.length ? Array.from(requesterSet).some((rid) => admins.includes(String(rid))) : false;
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Only room owner or admins can update settings' });

    // merge settings if provided
    if (setObj.settings && roomDoc.settings) {
      setObj.settings = { ...(roomDoc.settings || {}), ...(setObj.settings || {}) };
    }

    setObj.updatedAt = new Date();
    const updated = await Room.findByIdAndUpdate(id, { $set: setObj }, { new: true }).lean();
    if (updated) {
      try { rooms.set(String(updated._id), { id: String(updated._id), ...updated }); } catch (e) {}
      return res.json({ id: updated._id, ...updated });
    }
  } catch (e) {
    console.warn('Failed to update room', e?.message || e);
    return res.status(500).json({ message: 'Failed to update room' });
  }

  res.status(500).json({ message: 'Failed to update room' });
}));

router.post('/dm', requireVerifiedForHighRisk, asyncHandler(async (req, res) => {
  // Always trust the authenticated user as the DM creator (prevents inconsistent/forged ids)
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (e) {
    return res.status(401).json({ message: 'Invalid token' });
  }

  const requesterIdRaw = payload?.id;
  const targetIdRaw = req.body?.userId2;
  if (!requesterIdRaw || !targetIdRaw) {
    return res.status(400).json({ message: 'userId2 required' });
  }

  const requesterId = await canonicalIdForAuthPayload(payload);
  const targetId = await canonicalIdForUser(targetIdRaw);

  // Reuse existing DM if already created for this pair
  const requesterIds = await expandUserIdentifiers({ id: requesterId, email: payload?.email });
  const targetIds = await expandUserIdentifiers({ id: targetId, email: null });

  // Prevent self-DM even if ids are in different forms (guestId vs Mongo _id)
  const requesterSet = new Set(uniqStrings(requesterIds));
  const targetSet = new Set(uniqStrings(targetIds));
  for (const rid of requesterSet) {
    if (targetSet.has(rid)) {
      return res.status(400).json({ message: 'You cannot start a DM with yourself' });
    }
  }

  // Block enforcement: if either side has blocked the other, do not allow DM creation.
  try {
    const blocked = await isBlockedEitherWay({ aId: requesterId, aIds: Array.from(requesterSet), bId: targetId, bIds: Array.from(targetSet) });
    if (blocked) return res.status(403).json({ message: 'Cannot start DM: one of the users has blocked the other' });
  } catch (e) {
    // best-effort
  }

  // Privacy enforcement: if target only allows friends to DM, require friendship.
  try {
    const targetDoc = await User.findOne({ $or: [{ _id: String(targetId) }, { guestId: String(targetId) }] })
      .select('settings friends')
      .lean()
      .catch(() => null);
    const dmScope = targetDoc?.settings?.privacy?.dmScope || 'everyone';
    if (dmScope === 'friends') {
      const friends = Array.isArray(targetDoc?.friends) ? targetDoc.friends.map(String).filter(Boolean) : [];
      const ok = Array.from(requesterSet).some((rid) => friends.includes(String(rid)));
      if (!ok) {
        return res.status(403).json({ message: 'Only friends can send private messages.' });
      }
    }
  } catch (e) {
    // best-effort
  }

  const comboOr = [];
  for (const a of requesterSet) {
    for (const b of targetSet) {
      comboOr.push({ participants: { $all: [a, b] } });
      comboOr.push({ members: { $all: [a, b] } });
    }
  }

  try {
    const baseFilter = {
      category: 'dm',
      $or: [{ type: 'dm' }, { type: 'private' }]
    };
    const filter = comboOr.length ? { $and: [baseFilter, { $or: comboOr }] } : baseFilter;
    const existing = await Room.findOne(filter).sort({ updatedAt: -1, createdAt: -1 }).lean().exec();

    if (existing && existing._id) {
      // Keep in-memory cache lightly in sync
      try { rooms.set(String(existing._id), { id: String(existing._id), ...existing }); } catch (e) {}
      return res.json({ id: existing._id, ...existing });
    }
  } catch (e) {
    // If lookup fails, fall through to creating a new DM
  }

  const id = `dm-${Date.now()}`;
  // Store DM rooms as private rooms with category 'dm' so they are not listed as public
  const participants = [String(requesterId), String(targetId)];
  const room = { id, type: 'private', category: 'dm', participants };

  // persist
  try {
    const doc = new Room({ _id: id, name: `DM:${participants[0]}:${participants[1]}`, type: 'private', category: 'dm', participants, members: participants, createdBy: requesterId });
    await doc.save();
  } catch (e) { console.warn('Could not persist DM room', e?.message || e); }
  rooms.set(id, room);
  res.json(room);
}));

router.post('/random', requireVerifiedForHighRisk, async (req, res) => {
  const userId = req.body.userId;
  if (!userId) return res.status(400).json({ message: 'userId required' });

  // Try to find a waiting user to pair with
  for (let i = 0; i < waitingQueue.length; i++) {
    const waiter = waitingQueue[i];
    if (waiter.userId !== userId) {
      // Remove matched waiter
      waitingQueue.splice(i, 1);
      const id = `dm-${Date.now()}`;
      // Store as a private room with category 'dm'
      const room = { id, type: 'private', category: 'dm', participants: [waiter.userId, userId] };
      // persist
      try {
        const doc = new Room({ _id: id, name: `DM:${waiter.userId}:${userId}`, type: 'private', category: 'dm', participants: room.participants, members: room.participants, createdBy: waiter.userId });
        await doc.save();
      } catch (e) { console.warn('Could not persist random DM room', e?.message || e); }
      rooms.set(id, room);
      // resolve the waiting promise if present
      try {
        if (waiter.resolve) waiter.resolve(room);
      } catch (e) {}
      return res.json(room);
    }
  }

  // No match found, add to waiting queue and wait for up to 20s
  let resolver;
  const waitPromise = new Promise((resolve) => { resolver = resolve; });
  const entry = { userId, resolve: resolver, createdAt: Date.now() };
  waitingQueue.push(entry);

  // timeout to remove from queue
  const timeout = setTimeout(() => {
    const idx = waitingQueue.indexOf(entry);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    try { resolver(null); } catch (e) {}
  }, 20000);

  try {
    const matchedRoom = await waitPromise;
    clearTimeout(timeout);
    if (matchedRoom) {
      return res.json(matchedRoom);
    }
    // timed out, return waiting status
    return res.status(202).json({ status: 'waiting' });
  } catch (err) {
    clearTimeout(timeout);
    return res.status(500).json({ message: 'failed to join random queue' });
  }
});

export default router;
