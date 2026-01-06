import mongoose from 'mongoose';

const FriendRequestSchema = new mongoose.Schema({
  fromUserId: { type: String, required: true, index: true },
  toUserId: { type: String, required: true, index: true },
  status: { type: String, enum: ['pending', 'accepted', 'declined'], default: 'pending', index: true },
  message: { type: String },
  createdAt: { type: Date, default: Date.now, index: true }
});

FriendRequestSchema.index({ fromUserId: 1, toUserId: 1, status: 1 });

export default mongoose.models.FriendRequest || mongoose.model('FriendRequest', FriendRequestSchema);
