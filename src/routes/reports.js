import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import Report from '../models/Report.js';

const router = Router();

const getAuthUserId = (req) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return null;
    const payload = jwt.verify(token, env.jwtSecret);
    return payload?.id ? String(payload.id) : null;
  } catch (e) {
    return null;
  }
};

router.post('/', asyncHandler(async (req, res) => {
  const authUserId = getAuthUserId(req);
  const {
    // new payload
    messageId,
    targetUserId,
    roomId,
    reason,
    details,
    // backward-compat payload
    reporterId,
    targetId
  } = req.body || {};

  const resolvedReporterId = authUserId || (reporterId ? String(reporterId) : null);
  const resolvedTargetMessageId = messageId ? String(messageId) : (targetId ? String(targetId) : null);

  if (!resolvedReporterId) return res.status(401).json({ message: 'Unauthorized' });
  if (!resolvedTargetMessageId && !targetUserId) {
    return res.status(400).json({ message: 'messageId (or targetId) or targetUserId required' });
  }

  const doc = await Report.create({
    reporterId: resolvedReporterId,
    targetMessageId: resolvedTargetMessageId || undefined,
    targetUserId: targetUserId ? String(targetUserId) : undefined,
    roomId: roomId ? String(roomId) : undefined,
    reason: reason ? String(reason) : 'unspecified',
    details: details ? String(details) : undefined
  });

  res.json({ message: 'Report submitted', id: doc._id.toString() });
}));

export default router;
