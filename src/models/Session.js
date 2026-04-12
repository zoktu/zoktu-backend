import mongoose from 'mongoose';
import { env } from '../config/env.js';

const SessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: false, index: true },
  deviceId: { type: String, required: false },
  platform: { type: String, required: false, index: true },
  userAgent: { type: String, required: false },
  ip: { type: String, required: false },
  socketId: { type: String, required: false },
  revoked: { type: Boolean, default: false },
  revokedAt: { type: Date, required: false },
  risk: { type: Boolean, default: false },
  riskScore: { type: Number, required: false },
  riskReason: { type: String, required: false },
  createdAt: { type: Date, default: () => new Date() },
  lastActive: { type: Date, default: () => new Date(), index: { expires: (env.sessionTtlDays || 30) * 24 * 60 * 60 } }
});

const Session = mongoose.models.Session || mongoose.model('Session', SessionSchema);
export default Session;
