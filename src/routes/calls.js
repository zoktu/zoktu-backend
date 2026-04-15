import { Router } from 'express';
import { RtcTokenBuilder, RtcRole } from 'agora-token';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import User from '../models/User.js';

const router = Router();

// Cache user status for simple auth checking inline rather than full DB trip if possible
// But we'll rely on the JWT verification which sets req.userId
router.post('/token', asyncHandler(async (req, res) => {
  const { channelName, callType, uid } = req.body;
  const userId = req.userId;

  if (!env.agoraAppId || !env.agoraAppCertificate) {
    return res.status(500).json({ error: 'Agora credentials not configured' });
  }

  if (!channelName || !callType || typeof uid === 'undefined') {
    return res.status(400).json({ error: 'Missing required parameters: channelName, callType, uid' });
  }

  // Find user to verify permissions
  const user = await User.findById(userId).select('emailVerified isPremium userType premiumUntil subscription').lean();

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (!user.emailVerified) {
    return res.status(403).json({ error: 'Email verification required to make calls' });
  }

  const isPremium = Boolean(
    user.isPremium || 
    user.userType === 'premium' || 
    (user.subscription && user.subscription.plan === 'premium') || 
    (user.premiumUntil && new Date(user.premiumUntil) > new Date())
  );

  if (callType === 'video' && !isPremium) {
    return res.status(403).json({ error: 'Video calls require VIP/Premium status' });
  }

  // Token expires in 1 hour
  const expireTime = 3600;
  const currentTime = Math.floor(Date.now() / 1000);
  const privilegeExpireTime = currentTime + expireTime;

  // Build the token (role: PUBLISHER)
  const role = RtcRole.PUBLISHER;
  const token = RtcTokenBuilder.buildTokenWithUid(
    env.agoraAppId,
    env.agoraAppCertificate,
    channelName,
    uid,
    role,
    privilegeExpireTime
  );

  res.json({ token, channelName, appId: env.agoraAppId, uid, expireTime: privilegeExpireTime });
}));

export default router;
