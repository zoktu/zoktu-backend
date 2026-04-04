import GlobalBan from '../models/GlobalBan.js';
import { env } from '../config/env.js';
import User from '../models/User.js';
import jwt from 'jsonwebtoken';

/**
 * Checks if the request is from a globally banned IP or User.
 * This middleware should be applied early in the app.use stack.
 */
export const checkGlobalBan = async (req, res, next) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '').toString().split(',')[0].trim();
    
    // 1. Check IP Ban
    if (ip) {
      const ipBan = await GlobalBan.findOne({ 
        ip, 
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }] 
      }).lean();
      
      if (ipBan) {
        return res.status(403).json({ 
          message: 'Your IP has been globally banned from this platform.', 
          code: 'ERR_GLOBAL_BAN',
          reason: ipBan.reason 
        });
      }
    }

    // 2. Check User ID Ban (if authenticated)
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    
    if (token) {
      try {
        const payload = jwt.verify(token, env.jwtSecret);
        if (payload?.id) {
          const userBan = await GlobalBan.findOne({ 
            userId: String(payload.id),
            $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }]
          }).lean();
          
          if (userBan) {
            return res.status(403).json({ 
              message: 'Your account has been globally banned.', 
              code: 'ERR_GLOBAL_BAN',
              reason: userBan.reason 
            });
          }
        }
      } catch (e) {
        // Token invalid, ignore user-id ban check (will be caught by auth middleware later if needed)
      }
    }

    next();
  } catch (error) {
    console.error('Global ban check error:', error);
    next(); // fail-open to avoid locking out everyone on error
  }
};
