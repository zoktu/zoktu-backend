import mongoose from 'mongoose';
import { env } from '../config/env.js';

const NotificationSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  actorId: { type: String },
  roomId: { type: String },
  messageId: { type: String },
  type: { type: String, enum: ['dm', 'mention', 'reply', 'system'], default: 'system' },
  title: { type: String },
  message: { type: String },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, index: { expires: (env.notificationTtlDays || 60) * 24 * 60 * 60 } }
});

NotificationSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.models.Notification || mongoose.model('Notification', NotificationSchema);
