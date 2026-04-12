import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import Room from '../models/Room.js';
import DMRoom from '../models/DMRoom.js';
import RoomJoinRequest from '../models/RoomJoinRequest.js';
import { getModelForRoom } from '../models/Message.js';
import { users, upsertUserInMemory } from '../lib/userStore.js';
import User from '../models/User.js';
import requireVerifiedForHighRisk from '../middleware/riskGuard.js';
import { encryptMessageContent } from '../lib/messageCrypto.js';
import { pruneOldMessagesForRoom } from '../lib/messageRetention.js';
import { redisDeleteByPrefix, redisGetJson, redisSetJson } from '../lib/redis.js';

const router = Router();
const rooms = new Map();
// Simple in-memory waiting queue for random chat pairing
const waitingQueue = [];

const BOT_ID = env.botId || 'bot-baka';
const BOT_NAME = env.botName || 'Baka';
const BOT_AVATAR = env.botAvatar || '';
const BOT_ENABLED = String(env.botEnabled || '').toLowerCase() !== 'false';
const VIP_MEMBERS_ROOM_ID = String(env.vipMembersRoomId || 'room-1775384158848');
const VIP_MEMBERS_ROOM_NAME = 'vip members 👑';
const VIP_MEMBERS_ROOM_IDS = new Set([VIP_MEMBERS_ROOM_ID]);
const ROOM_MESSAGE_RETENTION_LIMIT = 50;

const parsePositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const ROOMS_LIST_CACHE_PREFIX = 'rooms:list:v1:';
const ROOMS_LIST_CACHE_TTL_SECONDS = parsePositiveInt(env.roomsListCacheTtlSeconds, 5);
const ROOMS_LIST_CACHE_LOCAL_TTL_MS = ROOMS_LIST_CACHE_TTL_SECONDS * 1000;
const ROOMS_LIST_CACHE_MAX_ENTRIES = parsePositiveInt(env.roomsListCacheMaxEntries, 800);
const ROOMS_LIST_CACHE_MAX_PAYLOAD_BYTES = parsePositiveInt(env.redisCacheMaxPayloadBytes, 64 * 1024);
const ROOMS_LIST_CACHE_CLEANUP_DELETE_LIMIT = parsePositiveInt(env.redisCacheCleanupDeleteLimit, 200);
const ROOMS_LIST_CACHE_INVALIDATE_DEBOUNCE_MS = 1200;

const roomsListLocalCache = new Map();
let lastRoomsListCacheInvalidateAt = 0;

const stableObjectString = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableObjectString(v)).join(',')}]`;

  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  return `{${entries.map(([k, v]) => `${k}:${stableObjectString(v)}`).join('|')}}`;
};

const buildRoomsListCacheKey = (query = {}) => {
  const compact = {
    type: query?.type ? String(query.type) : '',
    member: query?.member ? String(query.member) : '',
    discover: query?.discover ? String(query.discover) : ''
  };
  return `${ROOMS_LIST_CACHE_PREFIX}${stableObjectString(compact)}`;
};

const setRoomsListLocalCache = (cacheKey, value) => {
  if (!cacheKey) return;

  if (roomsListLocalCache.size >= ROOMS_LIST_CACHE_MAX_ENTRIES && !roomsListLocalCache.has(cacheKey)) {
    const overflow = roomsListLocalCache.size - ROOMS_LIST_CACHE_MAX_ENTRIES + 1;
    if (overflow > 0) {
      const victims = Array.from(roomsListLocalCache.entries())
        .sort((a, b) => Number(a[1]?.ts || 0) - Number(b[1]?.ts || 0))
        .slice(0, overflow)
        .map(([key]) => key);

      for (const victim of victims) {
        roomsListLocalCache.delete(victim);
      }
    }
  }

  roomsListLocalCache.set(cacheKey, { ts: Date.now(), value });
};

const getRoomsListCachedValue = async (cacheKey) => {
  if (!cacheKey) return null;

  const local = roomsListLocalCache.get(cacheKey);
  if (local && Date.now() - Number(local.ts || 0) < ROOMS_LIST_CACHE_LOCAL_TTL_MS) {
    return local.value;
  }

  if (local) roomsListLocalCache.delete(cacheKey);

  const redisValue = await redisGetJson(cacheKey);
  if (redisValue) {
    setRoomsListLocalCache(cacheKey, redisValue);
    return redisValue;
  }

  return null;
};

const setRoomsListCachedValue = async (cacheKey, value) => {
  if (!cacheKey || !Array.isArray(value)) return;
  setRoomsListLocalCache(cacheKey, value);
  void redisSetJson(cacheKey, value, ROOMS_LIST_CACHE_TTL_SECONDS, {
    cleanupPrefix: ROOMS_LIST_CACHE_PREFIX,
    cleanupDeleteLimit: ROOMS_LIST_CACHE_CLEANUP_DELETE_LIMIT,
    maxPayloadBytes: ROOMS_LIST_CACHE_MAX_PAYLOAD_BYTES
  });
};

const invalidateRoomsListCaches = async () => {
  const now = Date.now();
  if (now - lastRoomsListCacheInvalidateAt < ROOMS_LIST_CACHE_INVALIDATE_DEBOUNCE_MS) {
    return;
  }

  lastRoomsListCacheInvalidateAt = now;
  roomsListLocalCache.clear();
  await redisDeleteByPrefix(ROOMS_LIST_CACHE_PREFIX, ROOMS_LIST_CACHE_CLEANUP_DELETE_LIMIT);
};

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
          userType: 'guest'
        },
        $set: {
          displayName: String(BOT_NAME),
          name: String(BOT_NAME),
          username: String(BOT_NAME),
          isOnline: true,
          ...(BOT_AVATAR ? { avatar: String(BOT_AVATAR), photoURL: String(BOT_AVATAR) } : {})
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean().exec();
    if (!doc) return null;
    return upsertUserInMemory({ ...doc, id: String(doc.guestId || doc._id) });
  } catch (e) {
    const fallback = {
      id: String(BOT_ID),
      guestId: String(BOT_ID),
      displayName: String(BOT_NAME),
      name: String(BOT_NAME),
      username: String(BOT_NAME),
      userType: 'guest',
      ...(BOT_AVATAR ? { avatar: String(BOT_AVATAR), photoURL: String(BOT_AVATAR) } : {}),
      isOnline: true
    };
    return upsertUserInMemory(fallback);
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
  const normalized = canonical.filter(Boolean);
  if (normalized.length < 2) return null;
  return normalized.slice().sort().join('|');
};

const isDmRoomDoc = (doc) => Boolean(
  doc && (
    doc.type === 'dm' ||
    doc.category === 'dm' ||
    (doc.type === 'private' && doc.category === 'dm')
  )
);

const isPrivateNonDmRoom = (doc) => Boolean(
  doc && String(doc.type || '') === 'private' && String(doc.category || '') !== 'dm'
);

const isVipMembersRoom = (roomOrId) => {
  const roomId = String((typeof roomOrId === 'object' ? roomOrId?.id || roomOrId?._id : roomOrId) || '').trim();
  if (roomId && VIP_MEMBERS_ROOM_IDS.has(roomId)) return true;
  const roomName = String((typeof roomOrId === 'object' ? roomOrId?.name : '') || '').trim().toLowerCase();
  return roomName === VIP_MEMBERS_ROOM_NAME;
};

const isPremiumUserRecord = (userDoc) => {
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

const withDescriptionFallback = (room) => {
  if (!room || typeof room !== 'object') return room;

  const type = String(room.type || '').toLowerCase();
  const category = String(room.category || '').toLowerCase();
  const isDm = type === 'dm' || category === 'dm' || (type === 'private' && category === 'dm');
  if (isDm) return room;

  const description = typeof room.description === 'string' ? room.description.trim() : '';
  if (description) return room;

  const settingsDescription = typeof room.settings?.groupDescription === 'string'
    ? room.settings.groupDescription.trim()
    : '';
  if (!settingsDescription) return room;

  return { ...room, description: settingsDescription };
};

const getUserRecordForAnyIdentifier = async (id) => {
  if (!id) return null;
  const raw = String(id);
  const ors = [{ guestId: raw }, { email: raw }];
  if (/^[0-9a-fA-F]{24}$/.test(raw)) ors.unshift({ _id: raw });
  try {
    return await User.findOne({ $or: ors })
      .select('_id guestId email userType isPremium premiumStatus premiumUntil subscription')
      .lean()
      .exec();
  } catch (e) {
    return null;
  }
};

const resolveUserDisplayNameForSystem = async (rawId) => {
  const id = String(rawId || '').trim();
  if (!id) return 'Someone';

  try {
    const cached = users.get(id);
    const cachedName = String(cached?.displayName || cached?.name || cached?.username || '').trim();
    if (cachedName) return cachedName;
  } catch (e) {
    // ignore cache lookup failures
  }

  try {
    const ors = [{ guestId: id }, { email: id }];
    if (/^[0-9a-fA-F]{24}$/.test(id)) ors.unshift({ _id: id });
    const doc = await User.findOne({ $or: ors })
      .select('displayName name username')
      .lean()
      .exec();

    const name = String(doc?.displayName || doc?.name || doc?.username || '').trim();
    if (name) return name;
  } catch (e) {
    // ignore db lookup failures
  }

  return `User ${id.slice(-6) || id}`;
};

const emitRoomMembershipSystemMessage = async ({ roomId, roomDoc, targetUserId, action, io }) => {
  const rid = String(roomId || '').trim();
  if (!rid || !roomDoc) return;
  if (isDmRoomDoc(roomDoc)) return;

  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!['joined', 'left'].includes(normalizedAction)) return;

  const displayName = await resolveUserDisplayNameForSystem(targetUserId);
  const text = normalizedAction === 'joined'
    ? `${displayName} joined`
    : `${displayName} left`;

  try {
    const Model = getModelForRoom(roomDoc);
    const systemDoc = new Model({
      roomId: rid,
      senderId: 'system',
      senderName: 'System',
      content: encryptMessageContent(text),
      type: 'system',
      meta: {
        systemEvent: normalizedAction,
        targetUserId: String(targetUserId || '')
      }
    });

    await systemDoc.save();
    void pruneOldMessagesForRoom({
      Model,
      roomId: rid,
      keepLatest: ROOM_MESSAGE_RETENTION_LIMIT
    });

    if (io) {
      io.to(rid).emit('room:message', {
        id: systemDoc._id.toString(),
        roomId: rid,
        senderId: 'system',
        senderName: 'System',
        content: text,
        type: 'system',
        attachments: [],
        timestamp: systemDoc.createdAt,
        meta: systemDoc.meta || {}
      });
    }
  } catch (e) {
    // best-effort
  }
};

const parseAuthPayloadFromRequest = (req) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, env.jwtSecret);
  } catch (e) {
    return null;
  }
};

const toIsoDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const mapJoinRequestDoc = (doc) => ({
  id: String(doc?._id || ''),
  roomId: String(doc?.roomId || ''),
  fromUserId: String(doc?.fromUserId || ''),
  status: String(doc?.status || 'pending'),
  message: String(doc?.message || ''),
  reviewedBy: doc?.reviewedBy ? String(doc.reviewedBy) : null,
  reviewedAt: toIsoDate(doc?.reviewedAt),
  createdAt: toIsoDate(doc?.createdAt),
  updatedAt: toIsoDate(doc?.updatedAt)
});

const findRoomDocById = async (id) => {
  if (!id) return { doc: null, model: null };
  const preferDm = String(id).startsWith('dm-');
  const primary = preferDm ? DMRoom : Room;
  const secondary = preferDm ? Room : DMRoom;

  let doc = await primary.findById(id).lean().catch(() => null);
  if (doc) return { doc, model: primary };

  doc = await secondary.findById(id).lean().catch(() => null);
  if (doc) return { doc, model: secondary };

  return { doc: null, model: null };
};

const updateRoomById = async (id, update, options = {}) => {
  const { doc, model } = await findRoomDocById(id);
  if (!model || !doc) return null;
  await model.findByIdAndUpdate(id, update, options).catch(() => null);
  return model.findById(id).lean().catch(() => null);
};

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

router.use((req, res, next) => {
  if (req.method !== 'GET') {
    void invalidateRoomsListCaches();
  }
  next();
});

router.get('/', asyncHandler(async (req, res) => {
  const cacheKey = buildRoomsListCacheKey(req.query || {});
  const cached = await getRoomsListCachedValue(cacheKey);
  if (cached) return res.json(cached);

  // prefer DB-backed list but fall back to in-memory
  try {
    const { type, member, discover } = req.query || {};
    const roomType = type ? String(type) : null;
    const discoverPrivateRooms = roomType === 'private' && ['1', 'true', 'yes'].includes(String(discover || '').toLowerCase());
    const includeDmRooms = !discoverPrivateRooms;

    const and = [];
    if (roomType) and.push({ type: roomType });
    if (discoverPrivateRooms) {
      // Show only non-DM private groups in discover mode.
      and.push({
        $or: [
          { category: { $exists: false } },
          { category: null },
          { category: { $ne: 'dm' } }
        ]
      });
    }
    
    // Always exclude random chat rooms from the main discoverable or joined lists.
    // Random chats are transient and handled separately via the random chat interface.
    and.push({ category: { $ne: 'random' } });

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
    const [roomDocs, dmRoomDocs] = await Promise.all([
      Room.aggregate(pipeline).allowDiskUse(true).exec(),
      includeDmRooms ? DMRoom.aggregate(pipeline).allowDiskUse(true).exec() : Promise.resolve([])
    ]);
    const docs = [...(roomDocs || []), ...(dmRoomDocs || [])];

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

    const mapped = filtered
      .map(d => ({ id: d._id, ...d }))
      .map(withDescriptionFallback);
    await setRoomsListCachedValue(cacheKey, mapped);
    res.json(mapped);
    return;
  } catch (e) {
    // in-memory fallback with the same filters
    const { type, member, discover } = req.query || {};
    const t = type ? String(type) : null;
    const discoverPrivateRooms = t === 'private' && ['1', 'true', 'yes'].includes(String(discover || '').toLowerCase());
    const m = member ? String(member) : null;
    const filtered = Array.from(rooms.values()).filter((r) => {
      if (t && String(r.type) !== t) return false;
      if (discoverPrivateRooms && String(r.category || '') === 'dm') return false;
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

    const fallbackMapped = (deduped || []).map(withDescriptionFallback);
    await setRoomsListCachedValue(cacheKey, fallbackMapped);
    res.json(fallbackMapped);
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
  let roomModel = null;
  try {
    const found = await findRoomDocById(id);
    roomDoc = found.doc;
    roomModel = found.model;
  } catch (e) {}
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
    if (roomModel) {
      await roomModel.findByIdAndUpdate(
        id,
        { $addToSet: { hiddenFor: String(canonical) }, $set: { updatedAt: new Date() } },
        { upsert: false }
      ).lean();
    }
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
  const isTypeAdminDev = payload?.email === 'rohitbansal23rk@gmail.com' || (userRecord && userRecord.email === 'rohitbansal23rk@gmail.com');
  if (!isTypeAdminDev && (!effectiveUserType || effectiveUserType !== 'registered')) {
    return res.status(403).json({ message: 'Only registered users can create rooms' });
  }

  // Require email-verified for room creation
  const isAdminDev = userRecord && userRecord.email === 'rohitbansal23rk@gmail.com';
  const emailVerified = Boolean(userRecord && (userRecord.emailVerified || userRecord.emailVerified === true));
  if (!emailVerified && !isAdminDev) {
    return res.status(403).json({ message: 'Only email-verified registered users can create rooms' });
  }

  const id = `room-${Date.now()}`;
  const resolvedOwnerId = userRecord?._id || userRecord?.id || payload?.id || '';
  const ownerId = String(resolvedOwnerId || '').trim();
  const rawParticipants = Array.isArray(req.body.participants) ? req.body.participants : [];
  const rawMembers = Array.isArray(req.body.members) ? req.body.members : [];
  const rawAdmins = Array.isArray(req.body.admins) ? req.body.admins : [];
  const participants = Array.from(new Set([ownerId, ...rawParticipants.map(String)])).filter(Boolean);
  const members = Array.from(new Set([ownerId, ...rawMembers.map(String)])).filter(Boolean);
  const admins = Array.from(new Set([ownerId, ...rawAdmins.map(String)])).filter(Boolean);
  const room = {
    id,
    ...req.body,
    owner: ownerId,
    createdBy: ownerId,
    participants,
    members,
    admins
  };

  const normalizedSettings = {
    ...(room.settings || {})
  };
  if (String(room.type || '') === 'private' && String(room.category || '') !== 'dm') {
    normalizedSettings.requireApproval = true;
  }

  // Keep top-level description and settings.groupDescription aligned for group rooms.
  const isDmRoom = String(room.type || '') === 'dm' || String(room.category || '') === 'dm';
  if (!isDmRoom) {
    const hasDescription = typeof room.description === 'string' && room.description.length > 0;
    const hasGroupDescription = typeof normalizedSettings.groupDescription === 'string' && normalizedSettings.groupDescription.length > 0;

    if (hasDescription && !hasGroupDescription) {
      normalizedSettings.groupDescription = String(room.description);
    } else if (!hasDescription && hasGroupDescription) {
      room.description = String(normalizedSettings.groupDescription);
    } else if (hasDescription && hasGroupDescription) {
      // Prefer top-level description at creation time as canonical input.
      normalizedSettings.groupDescription = String(room.description);
    }
  }

  room.settings = normalizedSettings;

  // persist to DB
  try {
    const doc = new Room({ _id: id, name: room.name || '', description: room.description || '', type: room.type || 'public', owner: ownerId, createdBy: ownerId, participants: room.participants, members: room.members || room.participants, admins: room.admins || [], settings: room.settings || {}, category: room.category || '' });
    await doc.save();
  } catch (e) {
    // ignore persistence errors but keep in-memory
    console.warn('Could not persist room to DB', e?.message || e);
  }
  rooms.set(id, room);
  res.json(room);
}));

// List current user's private room join requests
router.get('/join-requests/mine', asyncHandler(async (req, res) => {
  const payload = parseAuthPayloadFromRequest(req);
  if (!payload) return res.status(401).json({ message: 'Unauthorized' });

  const canonical = (await canonicalIdForAuthPayload(payload)) || (payload?.id ? String(payload.id) : null);
  const expanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const fromIds = uniqStrings([canonical, ...(expanded || [])]);
  if (!fromIds.length) return res.status(401).json({ message: 'Unauthorized' });

  const rawStatus = String(req.query?.status || '').trim().toLowerCase();
  const status = ['pending', 'approved', 'rejected'].includes(rawStatus) ? rawStatus : null;

  const query = {
    fromUserId: { $in: fromIds },
    ...(status ? { status } : {})
  };

  const docs = await RoomJoinRequest.find(query)
    .sort({ createdAt: -1 })
    .lean()
    .exec();

  const rank = { pending: 3, approved: 2, rejected: 1 };
  const byRoom = new Map();
  for (const d of docs || []) {
    const roomId = String(d?.roomId || '').trim();
    if (!roomId) continue;

    const prev = byRoom.get(roomId);
    if (!prev) {
      byRoom.set(roomId, d);
      continue;
    }

    const prevRank = rank[String(prev?.status || '')] || 0;
    const nextRank = rank[String(d?.status || '')] || 0;
    if (nextRank > prevRank) {
      byRoom.set(roomId, d);
      continue;
    }

    const prevCreated = new Date(prev?.createdAt || 0).getTime();
    const nextCreated = new Date(d?.createdAt || 0).getTime();
    if (nextRank === prevRank && nextCreated > prevCreated) {
      byRoom.set(roomId, d);
    }
  }

  res.json(Array.from(byRoom.values()).map(mapJoinRequestDoc));
}));

// Create a join request for a private (non-DM) room
router.post('/:id/join-request', asyncHandler(async (req, res) => {
  const payload = parseAuthPayloadFromRequest(req);
  if (!payload) return res.status(401).json({ message: 'Unauthorized' });

  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ message: 'Invalid room id' });

  const found = await findRoomDocById(id);
  const roomDoc = found?.doc;
  const roomMem = rooms.get(id) || null;
  const room = roomDoc || roomMem;
  if (!room) return res.status(404).json({ message: 'Room not found' });
  if (isVipMembersRoom(room) || isVipMembersRoom(id)) {
    return res.status(403).json({ message: 'VIP room does not support join requests. VIP users are auto-added.' });
  }
  if (!isPrivateNonDmRoom(room)) {
    return res.status(400).json({ message: 'Join requests are only supported for private group rooms' });
  }

  const requesterCanonical = (await canonicalIdForAuthPayload(payload)) || (payload?.id ? String(payload.id) : null);
  const requesterExpanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const requesterIds = uniqStrings([requesterCanonical, ...(requesterExpanded || [])]);
  if (!requesterIds.length) return res.status(401).json({ message: 'Unauthorized' });

  const memberSet = new Set([
    ...((room.members || [])),
    ...((room.participants || [])),
    room.owner,
    room.createdBy
  ].map((v) => String(v || '').trim()).filter(Boolean));

  const alreadyMember = requesterIds.some((rid) => memberSet.has(String(rid)));
  if (alreadyMember) {
    return res.json({ message: 'You are already a member of this room', status: 'member' });
  }

  // Keep only one pending request per room per user (idempotent)
  const existingPending = await RoomJoinRequest.findOne({
    roomId: id,
    fromUserId: { $in: requesterIds },
    status: 'pending'
  }).lean().exec();
  if (existingPending) {
    return res.json({
      message: 'Join request already pending',
      request: mapJoinRequestDoc(existingPending)
    });
  }

  const message = String(req.body?.message || '').trim().slice(0, 200);
  const doc = new RoomJoinRequest({
    roomId: id,
    fromUserId: String(requesterCanonical || requesterIds[0]),
    status: 'pending',
    ...(message ? { message } : {})
  });
  await doc.save();

  const io = req.app.get('io');
  if (io) {
    try {
      io.to(id).emit('room:join-request:new', { roomId: id, requestId: String(doc._id) });
    } catch (e) {}
  }

  res.json({
    message: 'Join request sent',
    request: mapJoinRequestDoc(doc)
  });
}));

// Owner/admin: list join requests for a private room
router.get('/:id/join-requests', asyncHandler(async (req, res) => {
  const payload = parseAuthPayloadFromRequest(req);
  if (!payload) return res.status(401).json({ message: 'Unauthorized' });

  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ message: 'Invalid room id' });

  const found = await findRoomDocById(id);
  const roomDoc = found?.doc;
  const room = roomDoc || rooms.get(id) || null;
  if (!room) return res.status(404).json({ message: 'Room not found' });
  if (!isPrivateNonDmRoom(room)) {
    return res.status(400).json({ message: 'Join requests are only supported for private group rooms' });
  }

  const requesterExpanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const requesterCanonical = (await canonicalIdForAuthPayload(payload)) || (payload?.id ? String(payload.id) : null);
  const requesterSet = new Set(uniqStrings([requesterCanonical, ...(requesterExpanded || [])]));

  const ownerId = room.owner || room.createdBy;
  const admins = Array.isArray(room.admins) ? room.admins.map(String) : [];
  const isOwner = ownerId ? Array.from(requesterSet).some((rid) => String(ownerId) === String(rid)) : false;
  const isAdmin = admins.length ? Array.from(requesterSet).some((rid) => admins.includes(String(rid))) : false;
  if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Only owner/admin can review join requests' });

  const rawStatus = String(req.query?.status || '').trim().toLowerCase();
  const status = ['pending', 'approved', 'rejected'].includes(rawStatus) ? rawStatus : 'pending';

  const docs = await RoomJoinRequest.find({ roomId: id, status })
    .sort({ createdAt: -1 })
    .lean()
    .exec();

  res.json((docs || []).map(mapJoinRequestDoc));
}));

// Owner/admin: approve a pending join request
router.post('/:id/join-requests/:requestId/approve', asyncHandler(async (req, res) => {
  const payload = parseAuthPayloadFromRequest(req);
  if (!payload) return res.status(401).json({ message: 'Unauthorized' });

  const id = String(req.params.id || '').trim();
  const requestId = String(req.params.requestId || '').trim();
  if (!id || !requestId) return res.status(400).json({ message: 'Invalid request' });

  const found = await findRoomDocById(id);
  const roomDoc = found?.doc;
  const roomModel = found?.model;
  const roomMem = rooms.get(id) || null;
  const room = roomDoc || roomMem;
  if (!room) return res.status(404).json({ message: 'Room not found' });
  if (!isPrivateNonDmRoom(room)) {
    return res.status(400).json({ message: 'Join requests are only supported for private group rooms' });
  }

  const requesterExpanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const requesterCanonical = (await canonicalIdForAuthPayload(payload)) || (payload?.id ? String(payload.id) : null);
  const requesterSet = new Set(uniqStrings([requesterCanonical, ...(requesterExpanded || [])]));

  const ownerId = room.owner || room.createdBy;
  const admins = Array.isArray(room.admins) ? room.admins.map(String) : [];
  const isOwner = ownerId ? Array.from(requesterSet).some((rid) => String(ownerId) === String(rid)) : false;
  const isAdmin = admins.length ? Array.from(requesterSet).some((rid) => admins.includes(String(rid))) : false;
  if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Only owner/admin can approve join requests' });

  const reqDoc = await RoomJoinRequest.findOne({ _id: requestId, roomId: id }).lean().exec();
  if (!reqDoc) return res.status(404).json({ message: 'Join request not found' });
  if (String(reqDoc.status) === 'rejected') return res.status(400).json({ message: 'This request was rejected' });

  const candidateUserId = String(reqDoc.fromUserId || '').trim();
  if (!candidateUserId) return res.status(400).json({ message: 'Invalid requester id' });

  if (roomModel && roomDoc) {
    await roomModel.findByIdAndUpdate(
      id,
      {
        $addToSet: { participants: candidateUserId, members: candidateUserId },
        $set: { updatedAt: new Date() }
      },
      { upsert: false }
    ).catch(() => null);

    const fresh = await roomModel.findById(id).lean().catch(() => null);
    if (fresh) {
      try { rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh }); } catch (e) {}
    }
  } else if (roomMem) {
    roomMem.participants = Array.from(new Set([...(roomMem.participants || []).map(String), candidateUserId]));
    roomMem.members = Array.from(new Set([...(roomMem.members || []).map(String), candidateUserId]));
    roomMem.updatedAt = new Date();
    rooms.set(id, roomMem);
  }

  await RoomJoinRequest.findByIdAndUpdate(requestId, {
    $set: {
      status: 'approved',
      reviewedBy: String(requesterCanonical || ''),
      reviewedAt: new Date(),
      updatedAt: new Date()
    }
  }).catch(() => null);

  const updatedRequest = await RoomJoinRequest.findById(requestId).lean().catch(() => null);

  const io = req.app.get('io');
  if (io) {
    try {
      io.to(id).emit('room:join-request:updated', { roomId: id, requestId, status: 'approved' });
      const updatedRoom = await (roomModel ? roomModel.findById(id).lean().catch(() => null) : Promise.resolve(rooms.get(id) || null));
      if (updatedRoom) io.to(id).emit('room:update', { id: updatedRoom._id || id, ...updatedRoom });
    } catch (e) {}
  }

  res.json({
    message: 'Join request approved',
    request: updatedRequest ? mapJoinRequestDoc(updatedRequest) : null
  });
}));

// Owner/admin: reject a pending join request
router.post('/:id/join-requests/:requestId/reject', asyncHandler(async (req, res) => {
  const payload = parseAuthPayloadFromRequest(req);
  if (!payload) return res.status(401).json({ message: 'Unauthorized' });

  const id = String(req.params.id || '').trim();
  const requestId = String(req.params.requestId || '').trim();
  if (!id || !requestId) return res.status(400).json({ message: 'Invalid request' });

  const found = await findRoomDocById(id);
  const roomDoc = found?.doc;
  const room = roomDoc || rooms.get(id) || null;
  if (!room) return res.status(404).json({ message: 'Room not found' });
  if (!isPrivateNonDmRoom(room)) {
    return res.status(400).json({ message: 'Join requests are only supported for private group rooms' });
  }

  const requesterExpanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const requesterCanonical = (await canonicalIdForAuthPayload(payload)) || (payload?.id ? String(payload.id) : null);
  const requesterSet = new Set(uniqStrings([requesterCanonical, ...(requesterExpanded || [])]));

  const ownerId = room.owner || room.createdBy;
  const admins = Array.isArray(room.admins) ? room.admins.map(String) : [];
  const isOwner = ownerId ? Array.from(requesterSet).some((rid) => String(ownerId) === String(rid)) : false;
  const isAdmin = admins.length ? Array.from(requesterSet).some((rid) => admins.includes(String(rid))) : false;
  if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Only owner/admin can reject join requests' });

  const reqDoc = await RoomJoinRequest.findOne({ _id: requestId, roomId: id }).lean().exec();
  if (!reqDoc) return res.status(404).json({ message: 'Join request not found' });

  await RoomJoinRequest.findByIdAndUpdate(requestId, {
    $set: {
      status: 'rejected',
      reviewedBy: String(requesterCanonical || ''),
      reviewedAt: new Date(),
      updatedAt: new Date()
    }
  }).catch(() => null);

  const updatedRequest = await RoomJoinRequest.findById(requestId).lean().catch(() => null);

  const io = req.app.get('io');
  if (io) {
    try {
      io.to(id).emit('room:join-request:updated', { roomId: id, requestId, status: 'rejected' });
    } catch (e) {}
  }

  res.json({
    message: 'Join request rejected',
    request: updatedRequest ? mapJoinRequestDoc(updatedRequest) : null
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  // try DB first
  try {
    const found = await findRoomDocById(id);
    if (found?.doc) return res.json(withDescriptionFallback({ id: found.doc._id, ...found.doc }));
  } catch (e) {}
  const room = rooms.get(id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  res.json(withDescriptionFallback(room));
}));

router.post('/:id/join', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const userId = req.body.userId;
  if (!userId) return res.status(400).json({ message: 'userId required' });

  // Prefer DB-backed join so it survives restarts; fall back to in-memory.
  let roomDoc = null;
  let roomModel = null;
  try {
    const found = await findRoomDocById(id);
    roomDoc = found.doc;
    roomModel = found.model;
  } catch (e) {}

  const roomMem = rooms.get(id) || null;
  if (!roomDoc && !roomMem) return res.status(404).json({ message: 'Room not found' });

  const roomForBot = roomDoc || roomMem;
  const isVipRoom = isVipMembersRoom(roomForBot) || isVipMembersRoom(id);
  const joinerId = String(userId || '').trim();
  const expandedJoinerIds = await expandUserIdentifiers({ id: joinerId, email: null });
  const joinerIds = uniqStrings([joinerId, ...(expandedJoinerIds || [])]);

  const membersBeforeJoin = new Set([
    ...((roomForBot?.members || []).map(String)),
    ...((roomForBot?.participants || []).map(String)),
    String(roomForBot?.owner || ''),
    String(roomForBot?.createdBy || '')
  ].filter(Boolean));
  const wasAlreadyMember = joinerIds.some((rid) => membersBeforeJoin.has(String(rid)));

  // VIP room policy: only VIP users are allowed, and they can join directly (no request flow).
  if (isVipRoom) {
    const joinerRawId = String(userId || '').trim();
    const joinerCanonicalId = (await canonicalIdForUser(joinerRawId)) || joinerRawId;
    const joinerDoc =
      (await getUserRecordForAnyIdentifier(joinerCanonicalId)) ||
      (joinerCanonicalId !== joinerRawId ? await getUserRecordForAnyIdentifier(joinerRawId) : null);

    if (!isPremiumUserRecord(joinerDoc)) {
      return res.status(403).json({ message: 'VIP members only. Upgrade to VIP to join this room.' });
    }
  }

  // Private (non-DM) rooms require owner/admin approval before join.
  if (isPrivateNonDmRoom(roomForBot) && !isVipRoom) {
    const roomMembers = new Set([
      ...((roomForBot.members || []).map(String)),
      ...((roomForBot.participants || []).map(String)),
      String(roomForBot.owner || ''),
      String(roomForBot.createdBy || '')
    ].filter(Boolean));

    const alreadyMember = joinerIds.some((rid) => roomMembers.has(String(rid)));

    if (!alreadyMember) {
      const approved = await RoomJoinRequest.findOne({
        roomId: id,
        fromUserId: { $in: joinerIds },
        status: 'approved'
      }).sort({ reviewedAt: -1, updatedAt: -1, createdAt: -1 }).lean().exec();

      if (!approved) {
        const existingPending = await RoomJoinRequest.findOne({
          roomId: id,
          fromUserId: { $in: joinerIds },
          status: 'pending'
        }).sort({ createdAt: -1 }).lean().exec();

        if (existingPending) {
          return res.status(202).json({
            message: 'Join request pending approval',
            requiresApproval: true,
            request: mapJoinRequestDoc(existingPending)
          });
        }

        const newRequest = new RoomJoinRequest({
          roomId: id,
          fromUserId: String(joinerIds[0] || joinerId),
          status: 'pending'
        });
        await newRequest.save();

        const io = req.app.get('io');
        if (io) {
          try {
            io.to(id).emit('room:join-request:new', { roomId: id, requestId: String(newRequest._id) });
          } catch (e) {}
        }

        return res.status(202).json({
          message: 'Join request sent. Wait for owner/admin approval.',
          requiresApproval: true,
          request: mapJoinRequestDoc(newRequest)
        });
      }
    }
  }

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
  if (roomDoc && roomModel) {
    try {
      const addParticipants = shouldAddBot
        ? { $each: [String(userId), String(BOT_ID)] }
        : String(userId);
      // Ensure user record is persisted to MongoDB so names/stats survive server restarts
      const userToPersist = users.get(String(userId));
      if (userToPersist) {
        upsertUserInMemory(userToPersist, true);
      } else {
        const uDoc = await User.findOne({ $or: [{ _id: String(userId) }, { guestId: String(userId) }] }).lean().catch(() => null);
        if (uDoc) upsertUserInMemory(uDoc, true);
      }

      await roomModel.findByIdAndUpdate(
        id,
        { $addToSet: { participants: addParticipants, members: addParticipants }, $set: { updatedAt: new Date() } },
        { upsert: false }
      );
      const fresh = await roomModel.findById(id).lean().catch(() => null);
      if (fresh) {
        // keep cache lightly in sync
        try { rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh }); } catch (e) {}
        
        const io = req.app.get('io');
        if (io) {
          io.to(id).emit('room:member-joined', { roomId: id, userId: String(userId) });
          // Also emit room:update to refresh member lists
          io.to(id).emit('room:update', { id: fresh._id, ...fresh });
        }

        if (!wasAlreadyMember) {
          await emitRoomMembershipSystemMessage({
            roomId: id,
            roomDoc: fresh,
            targetUserId: String(userId),
            action: 'joined',
            io
          });
        }

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

  const io = req.app.get('io');
  if (io) {
    try {
      io.to(id).emit('room:member-joined', { roomId: id, userId: String(userId) });
      io.to(id).emit('room:update', { id: next.id || id, ...next });
    } catch (e) {}
  }

  if (!wasAlreadyMember) {
    await emitRoomMembershipSystemMessage({
      roomId: id,
      roomDoc: next,
      targetUserId: String(userId),
      action: 'joined',
      io
    });
  }

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
  let roomModel = null;
  try {
    const found = await findRoomDocById(id);
    roomDoc = found.doc;
    roomModel = found.model;
  } catch (e) {}
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
    if (roomDoc && roomModel) await roomModel.deleteOne({ _id: id });
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
  const found = await findRoomDocById(id);
  const roomDoc = found.doc;
  const roomModel = found.model;
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
      if (uniqueBannedIds.length) {
        updateObj.$addToSet = { bannedUsers: { $each: uniqueBannedIds } };
        // ALSO: Remove them from members/participants so they are kicked from the list immediately
        updateObj.$pull = { 
          members: { $in: uniqueBannedIds },
          participants: { $in: uniqueBannedIds }
        };
      }
      if (bannedIpList.length) {
        updateObj.$addToSet = Object.assign(updateObj.$addToSet || {}, { bannedIPs: { $each: bannedIpList } });
      }

      if (Object.keys(updateObj).length && roomModel) {
        await roomModel.findByIdAndUpdate(id, updateObj, { upsert: false }).catch(() => null);
      }

      try {
        const io = req.app.get('io');
        if (io) {
          io.to(id).emit('room:member-kicked', { roomId: id, targetUserId: targetUserId ? String(targetUserId) : null, targets: uniqueBannedIds });
          
          // Emit room:update so other members see the updated member list
          const fresh = await roomModel.findById(id).lean().catch(() => null);
          if (fresh) {
            io.to(id).emit('room:update', { id: fresh._id, ...fresh });
            // keep cache lightly in sync
            try { rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh }); } catch (e) {}
          }
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
  const found = await findRoomDocById(id);
  const roomDoc = found.doc;
  const roomModel = found.model;
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
    if (roomModel) {
      if (targetUserId) {
        await roomModel.findByIdAndUpdate(id, { $push: { mutedUsers: { userId: targetUserId, until } } }).catch(() => null);
      }
      if (ip) {
        await roomModel.findByIdAndUpdate(id, { $push: { mutedIPs: { ip, until } } }).catch(() => null);
      }

      try {
        const fresh = await roomModel.findById(id).lean().catch(() => null);
        if (fresh) {
          rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh });
        }
      } catch (e) {}
    }
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
  const found = await findRoomDocById(id);
  const roomDoc = found.doc;
  const roomModel = found.model;
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
  if (targetUserId) {
    const targetDoc = await User.findOne({ $or: [{ _id: String(targetUserId) }, { guestId: String(targetUserId) }] }).select('_id guestId email').lean().catch(() => null);
    const idToExpand = targetDoc?._id || targetUserId;
    const emailToExpand = targetDoc?.email || null;
    const equivalents = await expandUserIdentifiers({ id: idToExpand, email: emailToExpand });
    updateObj.$pull = { bannedUsers: { $in: uniqStrings(equivalents) } };
  }
  if (ip) updateObj.$pull = Object.assign(updateObj.$pull || {}, { bannedIPs: String(ip) });

  if (!Object.keys(updateObj).length) return res.status(400).json({ message: 'targetUserId or ip required' });

  try {
    if (roomModel) {
      await roomModel.findByIdAndUpdate(id, updateObj, { upsert: false }).catch(() => null);
      const fresh = await roomModel.findById(id).lean().catch(() => null);
      if (fresh) {
        rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh });
      }
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
  const found = await findRoomDocById(id);
  const roomDoc = found.doc;
  const roomModel = found.model;
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
    if (roomModel) {
      await roomModel.findByIdAndUpdate(id, updateObj, { upsert: false }).catch(() => null);
      const fresh = await roomModel.findById(id).lean().catch(() => null);
      if (fresh) {
        rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh });
      }
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
  let roomModel = null;
  try {
    const found = await findRoomDocById(id);
    roomDoc = found.doc;
    roomModel = found.model;
  } catch (e) {}
  const roomMem = rooms.get(id) || null;
  if (!roomDoc && !roomMem) return res.status(404).json({ message: 'Room not found' });

  const roomForLeave = roomDoc || roomMem;
  const leaverId = String(userId || '').trim();
  const expandedLeaverIds = await expandUserIdentifiers({ id: leaverId, email: null });
  const leaverIds = uniqStrings([leaverId, ...(expandedLeaverIds || [])]);
  const membersBeforeLeave = new Set([
    ...((roomForLeave?.members || []).map(String)),
    ...((roomForLeave?.participants || []).map(String)),
    String(roomForLeave?.owner || ''),
    String(roomForLeave?.createdBy || '')
  ].filter(Boolean));
  const wasMemberBeforeLeave = leaverIds.some((rid) => membersBeforeLeave.has(String(rid)));

  if (roomDoc && roomModel) {
    try {
      await roomModel.findByIdAndUpdate(
        id,
        { $pull: { participants: String(userId), members: String(userId) }, $set: { updatedAt: new Date() } },
        { upsert: false }
      );
      const fresh = await roomModel.findById(id).lean().catch(() => null);
      if (fresh) {
        try { rooms.set(String(fresh._id), { id: String(fresh._id), ...fresh }); } catch (e) {}
        
        const io = req.app.get('io');
        if (io) {
          io.to(id).emit('room:member-left', { roomId: id, userId: String(userId) });
          // Also emit room:update to refresh member lists
          io.to(id).emit('room:update', { id: fresh._id, ...fresh });
          // Special kick event for the person who left/was removed
          io.to(id).emit('room:member-kicked', { roomId: id, targetUserId: String(userId) });
        }

        if (wasMemberBeforeLeave) {
          await emitRoomMembershipSystemMessage({
            roomId: id,
            roomDoc: fresh,
            targetUserId: String(userId),
            action: 'left',
            io
          });
        }

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

  const io = req.app.get('io');
  if (io) {
    try {
      io.to(id).emit('room:member-left', { roomId: id, userId: String(userId) });
      io.to(id).emit('room:update', { id: next.id || id, ...next });
      io.to(id).emit('room:member-kicked', { roomId: id, targetUserId: String(userId) });
    } catch (e) {}
  }

  if (wasMemberBeforeLeave) {
    await emitRoomMembershipSystemMessage({
      roomId: id,
      roomDoc: next,
      targetUserId: String(userId),
      action: 'left',
      io
    });
  }

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
    const found = await findRoomDocById(id);
    const roomDoc = found.doc;
    const roomModel = found.model;
    if (!roomDoc || !roomModel) return res.status(404).json({ message: 'Room not found' });

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

    // Keep description and settings.groupDescription in sync for non-DM rooms.
    if (!isDmRoomDoc(roomDoc)) {
      const hasDescriptionUpdate = Object.prototype.hasOwnProperty.call(setObj, 'description');
      const hasSettingsUpdate = Object.prototype.hasOwnProperty.call(setObj, 'settings');
      const hasGroupDescriptionUpdate = Boolean(
        hasSettingsUpdate &&
        setObj.settings &&
        Object.prototype.hasOwnProperty.call(setObj.settings, 'groupDescription')
      );

      if (hasGroupDescriptionUpdate) {
        // If settings description changed, reflect it in top-level description used by room cards.
        setObj.description = String(setObj.settings.groupDescription || '');
      } else if (hasDescriptionUpdate) {
        // If top-level description changed directly, mirror it into settings.
        const syncedDescription = String(setObj.description || '');
        const baseSettings = hasSettingsUpdate
          ? { ...(setObj.settings || {}) }
          : { ...(roomDoc.settings || {}) };
        baseSettings.groupDescription = syncedDescription;
        setObj.settings = baseSettings;
      }
    }

    setObj.updatedAt = new Date();
    const updated = await roomModel.findByIdAndUpdate(id, { $set: setObj }, { new: true }).lean();
    if (updated) {
      try { rooms.set(String(updated._id), { id: String(updated._id), ...updated }); } catch (e) {}
      
      const io = req.app.get('io');
      if (io) {
        io.to(id).emit('room:update', { id: updated._id, ...updated });
      }

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

  const requesterSet = new Set(uniqStrings(requesterIds));
  const targetSet = new Set(uniqStrings(targetIds));
  const isSelfDm = Array.from(requesterSet).some((rid) => targetSet.has(String(rid)));

  // Block enforcement is only meaningful for two different users.
  try {
    if (!isSelfDm) {
      const blocked = await isBlockedEitherWay({ aId: requesterId, aIds: Array.from(requesterSet), bId: targetId, bIds: Array.from(targetSet) });
      if (blocked) return res.status(403).json({ message: 'Cannot start DM: one of the users has blocked the other' });
    }
  } catch (e) {
    // best-effort
  }

  // Privacy enforcement is only meaningful for two different users.
  try {
    if (!isSelfDm) {
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
    }
  } catch (e) {
    // best-effort
  }

  const comboOr = [];
  if (isSelfDm) {
    const selfIds = Array.from(new Set([...Array.from(requesterSet), ...Array.from(targetSet)]));

    // Match canonical self-DM shapes first.
    for (const sid of selfIds) {
      comboOr.push({ participants: [sid, sid] });
      comboOr.push({ members: [sid, sid] });
      comboOr.push({ participants: [sid] });
      comboOr.push({ members: [sid] });
    }

    // Also match legacy mixed-id rooms (e.g. _id + guestId of same user).
    for (let i = 0; i < selfIds.length; i += 1) {
      for (let j = i + 1; j < selfIds.length; j += 1) {
        const a = selfIds[i];
        const b = selfIds[j];
        comboOr.push({ participants: { $all: [a, b] } });
        comboOr.push({ members: { $all: [a, b] } });
      }
    }
  } else {
    for (const a of requesterSet) {
      for (const b of targetSet) {
        comboOr.push({ participants: { $all: [a, b] } });
        comboOr.push({ members: { $all: [a, b] } });
      }
    }
  }

  try {
    const baseFilter = {
      category: 'dm',
      $or: [{ type: 'dm' }, { type: 'private' }]
    };
    const filter = comboOr.length ? { $and: [baseFilter, { $or: comboOr }] } : baseFilter;

    const existingDm = await DMRoom.findOne(filter).sort({ updatedAt: -1, createdAt: -1 }).lean().exec();
    if (existingDm && existingDm._id) {
      try { rooms.set(String(existingDm._id), { id: String(existingDm._id), ...existingDm }); } catch (e) {}
      return res.json({ id: existingDm._id, ...existingDm });
    }

    const existingLegacy = await Room.findOne(filter).sort({ updatedAt: -1, createdAt: -1 }).lean().exec();
    if (existingLegacy && existingLegacy._id) {
      try { rooms.set(String(existingLegacy._id), { id: String(existingLegacy._id), ...existingLegacy }); } catch (e) {}
      return res.json({ id: existingLegacy._id, ...existingLegacy });
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
    const doc = new DMRoom({ _id: id, name: `DM:${participants[0]}:${participants[1]}`, type: 'private', category: 'dm', participants, members: participants, createdBy: requesterId });
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
      // Mark random-paired DM rooms as anonymous so clients can hide real identities
      const room = { id, type: 'private', category: 'dm', participants: [waiter.userId, userId], settings: { anonymous: true } };
      // persist
      try {
        const doc = new DMRoom({ _id: id, name: `DM:${waiter.userId}:${userId}`, type: 'private', category: 'dm', participants: room.participants, members: room.participants, createdBy: waiter.userId, settings: { anonymous: true } });
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
