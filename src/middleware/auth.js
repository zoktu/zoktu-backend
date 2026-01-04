import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import User from '../models/User.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    req.user = payload;
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
