import mongoose from 'mongoose';

const RoomSchema = new mongoose.Schema({
  _id: { type: String }, // use our generated id as _id for compatibility
  name: String,
  description: String,
  type: { type: String, enum: ['public', 'private', 'dm'], default: 'public' },
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
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

RoomSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.models.Room || mongoose.model('Room', RoomSchema);
