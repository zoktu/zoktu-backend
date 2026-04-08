import { createClient } from 'redis';
import { env } from '../config/env.js';

let redisClient = null;
let redisSubscriber = null;
let createRedisAdapterFn = null;
let connectPromise = null;

const REDIS_DEFAULT_RETRY_DELAY_MS = 150;
const REDIS_MAX_RETRY_DELAY_MS = 2000;
const REDIS_DEFAULT_MAX_RECONNECT_RETRIES = 6;
const REDIS_DEFAULT_SCAN_COUNT = 100;
const REDIS_DEFAULT_CLEANUP_DELETE_LIMIT = 200;
const REDIS_ERROR_LOG_SUPPRESS_WINDOW_MS = 5000;

let cleanupInFlightPromise = null;
let lastRedisErrorLogAt = 0;
let lastRedisErrorMessage = '';

const normalizeFlag = (value) => String(value ?? '').trim().toLowerCase();

const isRedisFeatureEnabled = () => {
  const url = String(env.redisUrl || '').trim();
  const enabledFlag = normalizeFlag(env.redisEnabled);
  const explicitlyDisabled = ['0', 'false', 'no', 'off'].includes(enabledFlag);
  if (!url) return false;
  return !explicitlyDisabled;
};

const safeDisconnect = async (client) => {
  if (!client) return;
  try {
    if (client.isOpen) {
      await client.quit();
    }
  } catch (e) {
    try {
      client.disconnect();
    } catch (inner) {
      // ignore
    }
  }
};

const isRedisOomError = (err) => {
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('oom') || message.includes('maxmemory');
};

const parsePositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const logRedisError = (label, err) => {
  const message = String(err?.message || err || '').trim();
  const now = Date.now();
  if (
    message &&
    message === lastRedisErrorMessage &&
    now - lastRedisErrorLogAt < REDIS_ERROR_LOG_SUPPRESS_WINDOW_MS
  ) {
    return;
  }

  lastRedisErrorMessage = message;
  lastRedisErrorLogAt = now;
  console.warn(`⚠️ ${label}: ${message}`);
};

const buildReconnectStrategy = (retries) => {
  const retryCount = Number(retries) || 0;
  const maxRetries = parsePositiveInt(env.redisMaxReconnectRetries, REDIS_DEFAULT_MAX_RECONNECT_RETRIES);
  if (retryCount >= maxRetries) {
    return new Error(`redis-max-retries-reached (${maxRetries})`);
  }
  return Math.min(REDIS_DEFAULT_RETRY_DELAY_MS * (retryCount + 1), REDIS_MAX_RETRY_DELAY_MS);
};

const withCleanupMutex = async (action) => {
  if (cleanupInFlightPromise) {
    await cleanupInFlightPromise.catch(() => {
      // ignore
    });
    return false;
  }

  cleanupInFlightPromise = (async () => {
    try {
      await action();
    } finally {
      cleanupInFlightPromise = null;
    }
  })();

  try {
    await cleanupInFlightPromise;
    return true;
  } catch (e) {
    return false;
  }
};

export const isRedisReady = () => Boolean(redisClient?.isOpen);

export const getRedisClient = () => (redisClient?.isOpen ? redisClient : null);

export const connectRedis = async () => {
  if (!isRedisFeatureEnabled()) {
    return { enabled: false, connected: false, reason: 'redis-disabled-or-missing-url' };
  }

  if (redisClient?.isOpen && redisSubscriber?.isOpen) {
    return { enabled: true, connected: true, client: redisClient, subscriber: redisSubscriber };
  }

  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    let primary = null;
    let subscriber = null;

    try {
      const url = String(env.redisUrl || '').trim();
      primary = createClient({
        url,
        socket: {
          reconnectStrategy: buildReconnectStrategy
        }
      });

      primary.on('error', (err) => {
        logRedisError('Redis client error', err);
      });

      subscriber = primary.duplicate();
      subscriber.on('error', (err) => {
        logRedisError('Redis subscriber error', err);
      });

      await primary.connect();
      await subscriber.connect();
      redisClient = primary;
      redisSubscriber = subscriber;
      console.log('✅ Redis connected');
      return { enabled: true, connected: true, client: redisClient, subscriber: redisSubscriber };
    } catch (err) {
      await safeDisconnect(subscriber);
      await safeDisconnect(primary);
      redisClient = null;
      redisSubscriber = null;
      console.warn(`⚠️ Redis unavailable, falling back to in-memory mode: ${err?.message || err}`);
      return { enabled: true, connected: false, reason: err?.message || 'redis-connect-failed' };
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
};

export const createSocketIoRedisAdapter = async () => {
  const state = await connectRedis();
  if (!state?.connected || !redisClient?.isOpen || !redisSubscriber?.isOpen) return null;

  if (!createRedisAdapterFn) {
    try {
      const mod = await import('@socket.io/redis-adapter');
      createRedisAdapterFn = mod?.createAdapter;
    } catch (err) {
      console.warn(`⚠️ Socket.IO Redis adapter not available: ${err?.message || err}`);
      return null;
    }
  }

  if (typeof createRedisAdapterFn !== 'function') return null;
  return createRedisAdapterFn(redisClient, redisSubscriber);
};

export const redisGetJson = async (key) => {
  const client = getRedisClient();
  const safeKey = String(key || '').trim();
  if (!client || !safeKey) return null;

  try {
    const raw = await client.get(safeKey);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
};

export const redisDeleteByPrefix = async (prefix, deleteLimit = REDIS_DEFAULT_CLEANUP_DELETE_LIMIT) => {
  const client = getRedisClient();
  const safePrefix = String(prefix || '').trim();
  const limit = parsePositiveInt(deleteLimit, REDIS_DEFAULT_CLEANUP_DELETE_LIMIT);
  if (!client || !safePrefix || limit <= 0) return 0;

  let deleted = 0;
  let cursor = '0';
  const matchPattern = `${safePrefix}*`;
  const scanCount = parsePositiveInt(process.env.REDIS_SCAN_COUNT, REDIS_DEFAULT_SCAN_COUNT);

  try {
    do {
      const result = await client.scan(cursor, { MATCH: matchPattern, COUNT: scanCount });
      cursor = String(result?.cursor ?? '0');
      const keys = Array.isArray(result?.keys) ? result.keys.filter(Boolean) : [];
      if (!keys.length) continue;

      const remaining = Math.max(0, limit - deleted);
      if (!remaining) break;

      const batch = keys.slice(0, remaining);
      if (!batch.length) continue;
      await client.del(batch);
      deleted += batch.length;
    } while (cursor !== '0' && deleted < limit);
  } catch (e) {
    return deleted;
  }

  return deleted;
};

export const redisSetJson = async (key, value, ttlSeconds = 0, options = {}) => {
  const client = getRedisClient();
  const safeKey = String(key || '').trim();
  if (!client || !safeKey) return false;

  try {
    const payload = JSON.stringify(value);
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    const maxPayloadBytes = parsePositiveInt(options?.maxPayloadBytes, 0);
    if (maxPayloadBytes > 0 && payloadBytes > maxPayloadBytes) {
      return false;
    }

    const ttl = Math.max(0, Math.floor(Number(ttlSeconds) || 0));
    if (ttl > 0) {
      await client.set(safeKey, payload, { EX: ttl });
    } else {
      await client.set(safeKey, payload);
    }
    return true;
  } catch (err) {
    if (!isRedisOomError(err)) return false;

    const cleanupPrefix = String(options?.cleanupPrefix || '').trim();
    const cleanupDeleteLimit = parsePositiveInt(
      options?.cleanupDeleteLimit,
      parsePositiveInt(process.env.REDIS_CACHE_CLEANUP_DELETE_LIMIT, REDIS_DEFAULT_CLEANUP_DELETE_LIMIT)
    );

    if (!cleanupPrefix) return false;

    await withCleanupMutex(async () => {
      const removed = await redisDeleteByPrefix(cleanupPrefix, cleanupDeleteLimit);
      if (removed > 0) {
        console.warn(`⚠️ Redis OOM cleanup: removed ${removed} keys from ${cleanupPrefix}*`);
      }
    });

    try {
      const payload = JSON.stringify(value);
      const ttl = Math.max(0, Math.floor(Number(ttlSeconds) || 0));
      if (ttl > 0) {
        await client.set(safeKey, payload, { EX: ttl });
      } else {
        await client.set(safeKey, payload);
      }
      return true;
    } catch (retryErr) {
      return false;
    }
  }
};

export const redisDel = async (key) => {
  const client = getRedisClient();
  const safeKey = String(key || '').trim();
  if (!client || !safeKey) return false;

  try {
    await client.del(safeKey);
    return true;
  } catch (err) {
    return false;
  }
};

export const closeRedisConnections = async () => {
  const client = redisClient;
  const subscriber = redisSubscriber;
  redisClient = null;
  redisSubscriber = null;
  await Promise.allSettled([safeDisconnect(subscriber), safeDisconnect(client)]);
};
