import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import User from '../models/User.js';
import Session from '../models/Session.js';

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

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    const sessionCheck = await validateSessionFromPayload(payload);
    if (sessionCheck.error) {
      return res.status(sessionCheck.error.status).json({ message: sessionCheck.error.message });
    }
    req.user = payload;
    req.session = sessionCheck.session;
    // record last IP for this user for moderation enforcement (best-effort, non-blocking)
    try {
      const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '').toString().split(',')[0].trim();
      if (payload && payload.id) {
        User.findByIdAndUpdate(payload.id, { $set: { lastIp: ip, lastActive: new Date() } }).catch(() => {});
      }
    } catch (e) {}
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
}
