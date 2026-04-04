import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { env } from '../config/env.js';
import User from '../models/User.js';
import GlobalBan from '../models/GlobalBan.js';
import jwt from 'jsonwebtoken';

const router = Router();

// Middleware to check if the user is a Super Admin
const requireSuperAdmin = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    const user = await User.findOne({ 
      $or: [
        { _id: String(payload.id) }, 
        { guestId: String(payload.id) }, 
        { email: String(payload.email) } 
      ] 
    }).lean();

    const isSuperAdminByEmail = user?.email === env.superAdminEmail;
    const isSuperAdminByRole = user?.role === 'superadmin';

    if (!isSuperAdminByEmail && !isSuperAdminByRole) {
      return res.status(403).json({ message: 'Only Super Admins can access this resource' });
    }
    
    req.admin = user;
    next();
  } catch (e) {
    return res.status(401).json({ message: 'Invalid token' });
  }
});

// Ban a user and their IP globally
router.post('/global-ban', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { targetUserId, targetIp, reason, durationDays } = req.body;
  if (!targetUserId && !targetIp) return res.status(400).json({ message: 'targetUserId or targetIp required' });

  const expiresAt = durationDays ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000) : null;
  
  const banEntry = new GlobalBan({
    userId: targetUserId,
    ip: targetIp,
    reason: reason || 'Violated platform rules',
    bannedBy: req.admin.email || req.admin._id,
    expiresAt
  });

  await banEntry.save();

  // Kick user via Socket.io if active
  const io = req.app.get('io');
  if (io) {
    // Kick by User ID
    if (targetUserId) {
      io.to(`user:${targetUserId}`).emit('global:kick', { reason });
      // Also potentially disconnect all sockets for this user if we track them
      // In this app, we can emit a broadcast if needed or specific rooms
      io.emit('presence:update', { userId: targetUserId, isOnline: false, banned: true });
    }
    // Disconnect any socket from this IP (if we track IP in sockets)
    // For now, the next request they make will be blocked by middleware
  }

  res.json({ message: 'User/IP globally banned successfully', ban: banEntry });
}));

// List all active global bans
router.get('/global-bans', requireSuperAdmin, asyncHandler(async (req, res) => {
  const bans = await GlobalBan.find({
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }]
  }).sort({ createdAt: -1 }).lean();
  res.json(bans);
}));

// Remove a global ban
router.delete('/global-ban/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  await GlobalBan.findByIdAndDelete(req.params.id);
  res.json({ message: 'Global ban removed successfully' });
}));

export default router;
