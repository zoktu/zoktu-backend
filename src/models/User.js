import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  email: { type: String, index: true, unique: true, sparse: true },
  guestId: { type: String, index: true, unique: true, sparse: true },
  password: String,
  displayName: String,
  name: String,
  userType: { type: String, default: 'registered' },
  emailVerified: { type: Boolean, default: false },
  // Profile fields
  bio: { type: String },
  age: { type: Number },
  gender: { type: String },
  dob: { type: Date },
  location: { type: String },
  avatar: { type: String },
  // Preferences / settings
  settings: {
    notifications: {
      messages: { type: Boolean, default: true },
      mentions: { type: Boolean, default: true },
      groupInvites: { type: Boolean, default: true },
      systemUpdates: { type: Boolean, default: false },
      soundEnabled: { type: Boolean, default: true },
      vibrationEnabled: { type: Boolean, default: true }
    },
    privacy: {
      profileVisibility: { type: String, enum: ['public', 'friends', 'private'], default: 'public' },
      showOnlineStatus: { type: Boolean, default: true },
      allowDirectMessages: { type: Boolean, default: true },
      showReadReceipts: { type: Boolean, default: true }
    },
    appearance: {
      fontSize: { type: String, enum: ['small', 'medium', 'large'], default: 'medium' },
      compactMode: { type: Boolean, default: false },
      showAvatars: { type: Boolean, default: true },
      animationsEnabled: { type: Boolean, default: true }
    },
    language: { type: String, default: 'english' }
  },
  // Session info for user sessions (debugging/management)
  sessions: [{ token: String, createdAt: Date, lastActive: Date }],
  resetToken: String,
  resetTokenExpires: Number,
  deletePending: Boolean,
  deleteRequestedAt: Number,
  deleteScheduledFor: Number,
  createdAt: { type: Date, default: Date.now }
  });

  // Ensure displayName is unique across all users (case-insensitive). Run migration first to resolve existing duplicates.
  UserSchema.index({ displayName: 1 }, { unique: true, collation: { locale: 'en', strength: 2 }, sparse: true });

  export default mongoose.models.User || mongoose.model('User', UserSchema);
