import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import Session from '../models/Session.js';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

const extractAuthPayload = (req) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return { error: { status: 401, message: 'Unauthorized' } };
  }
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    return { payload };
  } catch {
    return { error: { status: 401, message: 'Invalid token' } };
  }
};

const router = Router();

// List sessions for a user (self only)
router.get('/users/:id/sessions', asyncHandler(async (req, res) => {
  const auth = extractAuthPayload(req);
  if (auth.error) return res.status(auth.error.status).json({ message: auth.error.message });
  const payload = auth.payload;
  if (!payload || String(payload.id) !== String(req.params.id)) {
    return res.status(403).json({ message: 'forbidden' });
  }

  const sessions = await Session.find({ userId: String(req.params.id) }).sort({ lastActive: -1 }).lean().exec();
  res.json({ sessions });
}));

// Revoke a session (self only)
router.post('/:sessionId/revoke', asyncHandler(async (req, res) => {
  const auth = extractAuthPayload(req);
  if (auth.error) return res.status(auth.error.status).json({ message: auth.error.message });
  const payload = auth.payload;

  const { sessionId } = req.params;
  const session = await Session.findOne({ sessionId }).exec();
  if (!session) return res.status(404).json({ message: 'session not found' });
  if (String(session.userId) !== String(payload.id)) return res.status(403).json({ message: 'forbidden' });

  session.revoked = true;
  await session.save();
  res.json({ message: 'revoked' });
}));

export default router;
