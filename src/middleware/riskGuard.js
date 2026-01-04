import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import Session from '../models/Session.js';
import { users } from '../lib/userStore.js';

export const requireVerifiedForHighRisk = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (e) {
    return res.status(401).json({ message: 'Invalid token' });
  }

  // try session id header first
  const providedSessionId = req.headers['x-session-id'] || req.body?.sessionId || null;
  let session = null;
  try {
    if (providedSessionId) session = await Session.findOne({ sessionId: providedSessionId }).exec();
    if (!session) session = await Session.findOne({ userId: String(payload.id) }).sort({ lastActive: -1 }).lean().exec();
  } catch (e) {
    // continue
  }

  if (session && session.revoked) return res.status(403).json({ message: 'Session revoked' });
  if (session && session.risk) {
    // get user record for verification state
    const userRecord = Array.from(users.values()).find(u => String(u.id) === String(payload.id) || (u.email && u.email === payload.email));
    const isRegistered = userRecord && userRecord.userType === 'registered';
    const emailVerified = userRecord?.emailVerified;
    if (isRegistered && emailVerified) return next();
    return res.status(403).json({ message: 'High-risk session detected. Please register and verify your email to participate in DMs or random/group chats.' });
  }

  return next();
};

export default requireVerifiedForHighRisk;
