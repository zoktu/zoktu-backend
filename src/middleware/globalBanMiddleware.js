import GlobalBan from '../models/GlobalBan.js';
import { env } from '../config/env.js';
import User from '../models/User.js';
import jwt from 'jsonwebtoken';

const GLOBAL_BAN_CACHE_TTL_MS = 15 * 1000;
const GLOBAL_BAN_CACHE_MAX_ENTRIES = 4000;
const globalBanCache = new Map();

const makeCacheKey = (kind, value) => `${kind}:${String(value || '').trim()}`;

const readCachedBanEntry = (kind, value) => {
  const key = makeCacheKey(kind, value);
  const cached = globalBanCache.get(key);
  if (!cached) return null;

  if (Date.now() - Number(cached.ts || 0) > GLOBAL_BAN_CACHE_TTL_MS) {
    globalBanCache.delete(key);
    return null;
  }

  return cached;
};

const writeCachedBanEntry = (kind, value, ban) => {
  const key = makeCacheKey(kind, value);
  if (!key || key.endsWith(':')) return;

  if (globalBanCache.size >= GLOBAL_BAN_CACHE_MAX_ENTRIES && !globalBanCache.has(key)) {
    const overflow = globalBanCache.size - GLOBAL_BAN_CACHE_MAX_ENTRIES + 1;
    if (overflow > 0) {
      const oldestKeys = Array.from(globalBanCache.entries())
        .sort((a, b) => Number(a[1]?.ts || 0) - Number(b[1]?.ts || 0))
        .slice(0, overflow)
        .map(([cacheKey]) => cacheKey);

      for (const cacheKey of oldestKeys) {
        globalBanCache.delete(cacheKey);
      }
    }
  }

  globalBanCache.set(key, { ts: Date.now(), ban: ban || null });
};

const toActiveBanReason = (banDoc) => {
  if (!banDoc) return null;
  return {
    reason: banDoc.reason,
    code: 'ERR_GLOBAL_BAN'
  };
};

const shouldSkipGlobalBanCheck = (req) => {
  const path = String(req?.path || '').trim();
  return path === '/health' || path === '/' || path === '';
};

/**
 * Checks if the request is from a globally banned IP or User.
 * This middleware should be applied early in the app.use stack.
 */
export const checkGlobalBan = async (req, res, next) => {
  try {
    if (shouldSkipGlobalBanCheck(req)) return next();

    const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '').toString().split(',')[0].trim();

    const cachedIp = ip ? readCachedBanEntry('ip', ip) : null;
    if (cachedIp?.ban) {
      return res.status(403).json({
        message: 'Your IP has been globally banned from this platform.',
        ...toActiveBanReason(cachedIp.ban)
      });
    }

    // Check User ID Ban (if authenticated)
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    let authUserId = null;

    if (token) {
      try {
        const payload = jwt.verify(token, env.jwtSecret);
        if (payload?.id) authUserId = String(payload.id);
      } catch (e) {
        // Token invalid, ignore user-id ban check (will be caught by auth middleware later if needed)
      }
    }

    const cachedUser = authUserId ? readCachedBanEntry('user', authUserId) : null;
    if (cachedUser?.ban) {
      return res.status(403).json({
        message: 'Your account has been globally banned.',
        ...toActiveBanReason(cachedUser.ban)
      });
    }

    const needsIpLookup = Boolean(ip) && !cachedIp;
    const needsUserLookup = Boolean(authUserId) && !cachedUser;

    if (!needsIpLookup && !needsUserLookup) {
      return next();
    }

    const now = new Date();
    const identityOr = [];
    if (needsIpLookup) identityOr.push({ ip });
    if (needsUserLookup) identityOr.push({ userId: authUserId });

    const activeBan = identityOr.length
      ? await GlobalBan.findOne({
        $and: [
          { $or: identityOr },
          {
            $or: [
              { expiresAt: { $exists: false } },
              { expiresAt: null },
              { expiresAt: { $gt: now } }
            ]
          }
        ]
      })
        .select('reason ip userId expiresAt')
        .lean()
      : null;

    if (activeBan) {
      const banForIp = needsIpLookup && activeBan?.ip && String(activeBan.ip) === String(ip);
      const banForUser = needsUserLookup && activeBan?.userId && String(activeBan.userId) === String(authUserId);

      if (banForIp) {
        writeCachedBanEntry('ip', ip, activeBan);
      }
      if (banForUser) {
        writeCachedBanEntry('user', authUserId, activeBan);
      }

      if (banForIp) {
        return res.status(403).json({
          message: 'Your IP has been globally banned from this platform.',
          ...toActiveBanReason(activeBan)
        });
      }

      if (banForUser || (!banForIp && authUserId)) {
        return res.status(403).json({
          message: 'Your account has been globally banned.',
          ...toActiveBanReason(activeBan)
        });
      }
    }

    if (needsIpLookup) writeCachedBanEntry('ip', ip, null);
    if (needsUserLookup) writeCachedBanEntry('user', authUserId, null);

    next();
  } catch (error) {
    console.error('Global ban check error:', error);
    next(); // fail-open to avoid locking out everyone on error
  }
};
