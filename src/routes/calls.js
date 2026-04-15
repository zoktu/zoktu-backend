import { Router } from 'express';
import pkg from 'agora-token';
const { RtcTokenBuilder, RtcRole } = pkg;
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import User from '../models/User.js';
import Room from '../models/Room.js';
import { sendSystemMessage } from '../lib/systemMessages.js';
import { findUserSafely } from '../utils/userLookup.js';


const router = Router();

// Cache user status for simple auth checking inline rather than full DB trip if possible
// But we'll rely on the JWT verification which sets req.userId...
router.post('/token', asyncHandler(async (req, res) => {
  const { channelName, callType, uid } = req.body;
  const userId = req.user.id;

  if (!env.agoraAppId || !env.agoraAppCertificate) {
    return res.status(500).json({ error: 'Agora credentials not configured' });
  }

  if (!channelName || !callType || typeof uid === 'undefined') {
    return res.status(400).json({ error: 'Missing required parameters: channelName, callType, uid' });
  }

  // Find user to verify permissions
  const user = await findUserSafely(userId, 'emailVerified isPremium userType premiumUntil subscription');

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const isGroupVoice = String(channelName).startsWith('room_');
  const roomId = isGroupVoice ? String(channelName).replace('room_', '') : null;

  if (isGroupVoice && !user.emailVerified) {
    return res.status(403).json({ error: 'Email verification required for Group Voice Chat' });
  }

  // If it's a 1v1 call, we check if they are verified OR if it's an incoming call.
  // We'll allow Guests to at least receive calls for the "trailer" experience.
  const isDirectCall = String(channelName).startsWith('ch_');
  if (!user.emailVerified && user.userType === 'guest' && !isDirectCall && !isGroupVoice) {
    return res.status(403).json({ error: 'Email verification required to initiate calls' });
  }

  // Room Voice Initiation Logic: Only Owner/Admin can start it
  if (isGroupVoice) {
    const room = await Room.findById(roomId).select('owner admins isVoiceActive').lean();
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const isAdmin = room.owner === userId || (Array.isArray(room.admins) && room.admins.includes(userId));
    
    if (!room.isVoiceActive && !isAdmin) {
      return res.status(403).json({ error: 'Voice chat must be started by an admin' });
    }

    // If admin is joining and it's not active yet, mark it active
    if (isAdmin && !room.isVoiceActive) {
      await Room.findByIdAndUpdate(roomId, { isVoiceActive: true });
      const io = req.app.get('io');
      if (io) {
        io.to(roomId).emit('room:voice:status', { roomId, isActive: true });
        sendSystemMessage(io, roomId, 'Voice chat started by an admin');
      }

    }
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

  // Build the token (role: PUBLISHER) using User Account (supports strings)
  const role = RtcRole.PUBLISHER;
  const token = RtcTokenBuilder.buildTokenWithUserAccount(
    env.agoraAppId,
    env.agoraAppCertificate,
    channelName,
    String(uid), // map string UID to userAccount
    role,
    privilegeExpireTime
  );

  res.json({ token, channelName, appId: env.agoraAppId, uid, expireTime: privilegeExpireTime });
}));

export default router;
