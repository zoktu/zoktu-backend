import mongoose from 'mongoose';

const SessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: false, index: true },
  deviceId: { type: String, required: false },
  userAgent: { type: String, required: false },
  ip: { type: String, required: false },
  socketId: { type: String, required: false },
  revoked: { type: Boolean, default: false },
  risk: { type: Boolean, default: false },
  riskScore: { type: Number, required: false },
  riskReason: { type: String, required: false },
  createdAt: { type: Date, default: () => new Date() },
  lastActive: { type: Date, default: () => new Date() }
});

const Session = mongoose.models.Session || mongoose.model('Session', SessionSchema);
export default Session;
