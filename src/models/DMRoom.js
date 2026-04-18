import mongoose from 'mongoose';

const DMRoomSchema = new mongoose.Schema({
  _id: { type: String },
  name: String,
  description: String,
  type: { type: String, enum: ['public', 'private', 'dm'], default: 'private' },
  owner: String,
  createdBy: String,
  createdBySystem: { type: Boolean, default: false },
  participants: [String],
  members: [String],
  admins: [String],
  bannedUsers: [String],
  bannedIPs: [String],
  mutedUsers: [{ userId: String, until: Date }],
  mutedIPs: [{ ip: String, until: Date }],
  settings: { type: Object },
  category: String,
  hiddenFor: [String],
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

DMRoomSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Query-performance indexes for DM room lookup and listing.
DMRoomSchema.index({ type: 1, category: 1, updatedAt: -1 });
DMRoomSchema.index({ owner: 1, updatedAt: -1 });
DMRoomSchema.index({ createdBy: 1, updatedAt: -1 });
DMRoomSchema.index({ members: 1, updatedAt: -1 });
DMRoomSchema.index({ participants: 1, updatedAt: -1 });
DMRoomSchema.index({ createdAt: -1 });

export default mongoose.models.DMRoom || mongoose.model('DMRoom', DMRoomSchema, 'dm_rooms');
