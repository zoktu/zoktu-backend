import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import Session from '../models/Session.js';
import { users } from '../lib/userStore.js';

const resolveClientOrigin = () => {
  const raw = String(env.clientOrigin || '').trim();
  if (!raw) return 'https://zoktu.com';
  const first = raw.split(',').map(s => s.trim()).filter(Boolean)[0];
  return first || 'https://zoktu.com';
};

const buildRestrictedUrl = () => `${resolveClientOrigin().replace(/\/$/, '')}/access-restricted`;

const sendHighRiskBlockedResponse = (req, res) => {
  const redirectUrl = buildRestrictedUrl();
  const payload = {
    message: 'High-risk session detected. Please disable VPN/Proxy/Anonymizer to continue.',
    code: 'HIGH_RISK_SESSION',
    redirectUrl
  };

  const acceptsHtml = String(req.headers.accept || '').includes('text/html');
  if (acceptsHtml && req.method === 'GET') {
    return res.redirect(302, redirectUrl);
  }

  return res.status(403).json(payload);
};

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
    return sendHighRiskBlockedResponse(req, res);
  }

  return next();
};

export default requireVerifiedForHighRisk;
