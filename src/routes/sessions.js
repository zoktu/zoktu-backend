import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import Session from '../models/Session.js';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import User from '../models/User.js';

const maskIpAddress = (ipRaw) => {
  const ip = String(ipRaw || '').trim();
  if (!ip) return 'Unknown IP';

  const normalized = ip.replace(/^::ffff:/i, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    const parts = normalized.split('.');
    parts[3] = '0';
    return parts.join('.');
  }

  if (normalized.includes(':')) {
    const segments = normalized.split(':').filter(Boolean);
    if (!segments.length) return 'Unknown IP';
    const prefix = segments.slice(0, 2).join(':');
    return prefix ? `${prefix}:****:****` : '****:****';
  }

  return normalized.length > 8 ? `${normalized.slice(0, 8)}…` : normalized;
};

const summarizeUserAgent = (uaRaw) => {
  const ua = String(uaRaw || '').replace(/\s+/g, ' ').trim();
  if (!ua) return 'Unknown device';
  return ua.length > 80 ? `${ua.slice(0, 80)}…` : ua;
};

const presentSessionForClient = (sessionDoc, currentSessionId) => {
  const sessionId = String(sessionDoc?.sessionId || '').trim();
  const publicId = String(sessionDoc?._id || sessionId || '').trim();

  return {
    // Return a non-sensitive reference for revoke flow/UI keys.
    id: publicId,
    platform: String(sessionDoc?.platform || '').trim() || 'web',
    userAgent: summarizeUserAgent(sessionDoc?.userAgent),
    ip: maskIpAddress(sessionDoc?.ip),
    risk: Boolean(sessionDoc?.risk),
    createdAt: sessionDoc?.createdAt || null,
    lastActive: sessionDoc?.lastActive || null,
    isCurrent: Boolean(currentSessionId && sessionId && String(currentSessionId) === sessionId)
  };
};

const validateSessionFromPayload = async (payload) => {
  if (!payload?.sessionId) {
    return { error: { status: 401, message: 'Session expired' } };
  }
  const sessionId = String(payload.sessionId);
  const session = await Session.findOne({ sessionId, revoked: { $ne: true } }).lean().exec();
  if (!session) {
    return { error: { status: 401, message: 'Session expired' } };
  }
  const payloadId = String(payload.id || payload.userId || payload._id || payload.guestId || '');
  if (!payloadId || String(session.userId) !== payloadId) {
    return { error: { status: 401, message: 'Session expired' } };
  }

  Session.updateOne({ sessionId }, { $set: { lastActive: new Date() } }).catch(() => {});
  return { session };
};

const extractAuthPayload = async (req) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return { error: { status: 401, message: 'Unauthorized' } };
  }
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    const sessionCheck = await validateSessionFromPayload(payload);
    if (sessionCheck.error) return { error: sessionCheck.error };
    return { payload, session: sessionCheck.session };
  } catch {
    return { error: { status: 401, message: 'Invalid token' } };
  }
};

const router = Router();

// Session metadata should never be cached by browsers/intermediaries.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

const uniqStrings = (arr) => Array.from(new Set((arr || []).filter(Boolean).map((v) => String(v))));

const expandViewerIds = async (payload) => {
  const ids = new Set();
  if (!payload) return ids;
  if (payload.id) ids.add(String(payload.id));
  if (payload.userId) ids.add(String(payload.userId));
  if (payload._id) ids.add(String(payload._id));
  if (payload.guestId) ids.add(String(payload.guestId));

  // Resolve by email to include Mongo _id + guestId.
  try {
    if (payload.email) {
      const doc = await User.findOne({ email: String(payload.email) }).select('_id guestId').lean().exec().catch(() => null);
      if (doc?._id) ids.add(String(doc._id));
      if (doc?.guestId) ids.add(String(doc.guestId));
    }
  } catch (e) {
    // ignore
  }

  return ids;
};

// List sessions for a user (self only)
router.get('/users/:id/sessions', asyncHandler(async (req, res) => {
  const auth = await extractAuthPayload(req);
  if (auth.error) return res.status(auth.error.status).json({ message: auth.error.message });
  const payload = auth.payload;
  const currentSessionId = String(payload?.sessionId || '').trim();

  const viewerIds = await expandViewerIds(payload);
  const paramId = String(req.params.id);
  if (!viewerIds.size || !Array.from(viewerIds).includes(paramId)) {
    return res.status(403).json({ message: 'forbidden' });
  }

  const sessions = await Session.find({ userId: paramId, revoked: { $ne: true } }).sort({ lastActive: -1 }).lean().exec();
  res.json({ sessions: sessions.map((entry) => presentSessionForClient(entry, currentSessionId)) });
}));

// List sessions for the currently authenticated user
router.get('/me', asyncHandler(async (req, res) => {
  const auth = await extractAuthPayload(req);
  if (auth.error) return res.status(auth.error.status).json({ message: auth.error.message });
  const currentSessionId = String(auth.payload?.sessionId || '').trim();

  const viewerIds = await expandViewerIds(auth.payload);
  const ids = uniqStrings(Array.from(viewerIds));
  if (!ids.length) {
    return res.json({ sessions: [] });
  }

  const sessions = await Session.find({ userId: { $in: ids }, revoked: { $ne: true } })
    .sort({ lastActive: -1 })
    .lean()
    .exec();
  res.json({ sessions: sessions.map((entry) => presentSessionForClient(entry, currentSessionId)) });
}));

// Revoke a session (self only)
router.post('/:sessionId/revoke', asyncHandler(async (req, res) => {
  const auth = await extractAuthPayload(req);
  if (auth.error) return res.status(auth.error.status).json({ message: auth.error.message });
  const payload = auth.payload;

  const viewerIds = await expandViewerIds(payload);

  const sessionRef = String(req.params.sessionId || '').trim();
  if (!sessionRef) return res.status(400).json({ message: 'invalid session reference' });

  const query = /^[a-f\d]{24}$/i.test(sessionRef)
    ? { $or: [{ _id: sessionRef }, { sessionId: sessionRef }] }
    : { sessionId: sessionRef };

  const session = await Session.findOne(query).exec();
  if (!session) return res.status(404).json({ message: 'session not found' });
  if (!viewerIds.size || !Array.from(viewerIds).includes(String(session.userId))) {
    return res.status(403).json({ message: 'forbidden' });
  }

  session.revoked = true;
  session.revokedAt = new Date();
  await session.save();
  res.json({ message: 'revoked' });
}));

export default router;
