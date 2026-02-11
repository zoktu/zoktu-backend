import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import Session from '../models/Session.js';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import User from '../models/User.js';

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

  const viewerIds = await expandViewerIds(payload);
  const paramId = String(req.params.id);
  if (!viewerIds.size || !Array.from(viewerIds).includes(paramId)) {
    return res.status(403).json({ message: 'forbidden' });
  }

  const sessions = await Session.find({ userId: paramId, revoked: { $ne: true } }).sort({ lastActive: -1 }).lean().exec();
  res.json({ sessions });
}));

// List sessions for the currently authenticated user
router.get('/me', asyncHandler(async (req, res) => {
  const auth = await extractAuthPayload(req);
  if (auth.error) return res.status(auth.error.status).json({ message: auth.error.message });

  const viewerIds = await expandViewerIds(auth.payload);
  const ids = uniqStrings(Array.from(viewerIds));
  if (!ids.length) {
    return res.json({ sessions: [] });
  }

  const sessions = await Session.find({ userId: { $in: ids }, revoked: { $ne: true } })
    .sort({ lastActive: -1 })
    .lean()
    .exec();
  res.json({ sessions });
}));

// Revoke a session (self only)
router.post('/:sessionId/revoke', asyncHandler(async (req, res) => {
  const auth = await extractAuthPayload(req);
  if (auth.error) return res.status(auth.error.status).json({ message: auth.error.message });
  const payload = auth.payload;

  const viewerIds = await expandViewerIds(payload);

  const { sessionId } = req.params;
  const session = await Session.findOne({ sessionId }).exec();
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
