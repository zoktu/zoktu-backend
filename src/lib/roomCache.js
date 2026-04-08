import Room from '../models/Room.js';
import DMRoom from '../models/DMRoom.js';
import { redisDel, redisGetJson, redisSetJson } from './redis.js';
import { env } from '../config/env.js';

const toPositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const ROOM_CACHE_TTL_SECONDS = toPositiveInt(env.redisRoomCacheTtlSeconds, 30);
const ROOM_CACHE_TTL_MS = ROOM_CACHE_TTL_SECONDS * 1000;
const ROOM_CACHE_MAX_ENTRIES = toPositiveInt(env.roomCacheMaxEntries, 400);
const REDIS_CACHE_MAX_PAYLOAD_BYTES = toPositiveInt(env.redisCacheMaxPayloadBytes, 64 * 1024);
const REDIS_CACHE_CLEANUP_DELETE_LIMIT = toPositiveInt(env.redisCacheCleanupDeleteLimit, 200);
const ROOM_CACHE_PREFIX = 'room:doc:v1:';

const roomCache = new Map();

const getRoomCacheKey = (id) => `${ROOM_CACHE_PREFIX}${String(id)}`;

const readLocalRoomCache = (id) => {
  const key = String(id || '').trim();
  if (!key) return null;
  const cached = roomCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts >= ROOM_CACHE_TTL_MS) {
    roomCache.delete(key);
    return null;
  }
  return cached.doc;
};

const writeLocalRoomCache = (id, doc) => {
  const key = String(id || '').trim();
  if (!key || !doc) return;

  if (roomCache.size >= ROOM_CACHE_MAX_ENTRIES && !roomCache.has(key)) {
    // Evict oldest local entries first to keep process memory bounded.
    const overflow = roomCache.size - ROOM_CACHE_MAX_ENTRIES + 1;
    if (overflow > 0) {
      const keysByOldest = Array.from(roomCache.entries())
        .sort((a, b) => Number(a[1]?.ts || 0) - Number(b[1]?.ts || 0))
        .slice(0, overflow)
        .map((entry) => entry[0]);

      for (const victimKey of keysByOldest) {
        roomCache.delete(victimKey);
      }
    }
  }

  roomCache.set(key, { ts: Date.now(), doc });
};

const fetchRoomDocById = async (id, select = null) => {
  if (!id) return null;
  const roomId = String(id);
  const preferDm = roomId.startsWith('dm-');
  const primary = preferDm ? DMRoom : Room;
  const secondary = preferDm ? Room : DMRoom;

  let query = primary.findById(roomId);
  if (select) query = query.select(select);

  let doc = await query.lean().catch(() => null);
  if (doc) return doc;

  query = secondary.findById(roomId);
  if (select) query = query.select(select);
  doc = await query.lean().catch(() => null);
  return doc;
};

export const invalidateRoomDocCache = async (id) => {
  const roomId = String(id || '').trim();
  if (!roomId) return;

  roomCache.delete(roomId);
  const redisKey = getRoomCacheKey(roomId);
  await redisDel(redisKey);
};

export const getRoomDocByIdWithCache = async (id, select = null) => {
  if (!id) return null;
  const roomId = String(id);

  // Avoid projection-specific cache complexity.
  if (select) {
    return fetchRoomDocById(roomId, select);
  }

  const localCached = readLocalRoomCache(roomId);
  if (localCached) return localCached;

  const redisKey = getRoomCacheKey(roomId);
  const redisCached = await redisGetJson(redisKey);
  if (redisCached) {
    writeLocalRoomCache(roomId, redisCached);
    return redisCached;
  }

  const doc = await fetchRoomDocById(roomId);
  if (!doc) return null;

  writeLocalRoomCache(roomId, doc);
  void redisSetJson(redisKey, doc, ROOM_CACHE_TTL_SECONDS, {
    cleanupPrefix: ROOM_CACHE_PREFIX,
    cleanupDeleteLimit: REDIS_CACHE_CLEANUP_DELETE_LIMIT,
    maxPayloadBytes: REDIS_CACHE_MAX_PAYLOAD_BYTES
  });
  return doc;
};

export const updateRoomDocByIdWithCache = async (id, update, options = {}) => {
  if (!id) return null;
  const roomId = String(id);

  await invalidateRoomDocCache(roomId);

  const preferDm = roomId.startsWith('dm-');
  const primary = preferDm ? DMRoom : Room;
  const secondary = preferDm ? Room : DMRoom;

  await primary.findByIdAndUpdate(roomId, update, options).catch(() => null);
  let doc = await primary.findById(roomId).lean().catch(() => null);

  if (!doc) {
    await secondary.findByIdAndUpdate(roomId, update, options).catch(() => null);
    doc = await secondary.findById(roomId).lean().catch(() => null);
  }

  if (doc) {
    writeLocalRoomCache(roomId, doc);
    void redisSetJson(getRoomCacheKey(roomId), doc, ROOM_CACHE_TTL_SECONDS, {
      cleanupPrefix: ROOM_CACHE_PREFIX,
      cleanupDeleteLimit: REDIS_CACHE_CLEANUP_DELETE_LIMIT,
      maxPayloadBytes: REDIS_CACHE_MAX_PAYLOAD_BYTES
    });
  }

  return doc;
};
