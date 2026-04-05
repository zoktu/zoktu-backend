import mongoose from 'mongoose';

const RoomJoinRequestSchema = new mongoose.Schema({
  roomId: { type: String, required: true, index: true },
  fromUserId: { type: String, required: true, index: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  message: { type: String, default: '' },
  reviewedBy: { type: String },
  reviewedAt: { type: Date },
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
});

RoomJoinRequestSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

RoomJoinRequestSchema.index(
  { roomId: 1, fromUserId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending' }
  }
);

// Read-path indexes for moderation and requester history endpoints.
RoomJoinRequestSchema.index({ roomId: 1, status: 1, createdAt: -1 });
RoomJoinRequestSchema.index({ fromUserId: 1, status: 1, createdAt: -1 });

export default mongoose.models.RoomJoinRequest || mongoose.model('RoomJoinRequest', RoomJoinRequestSchema);
