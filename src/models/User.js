import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  email: { type: String, index: true, unique: true, sparse: true },
  guestId: { type: String, index: true, unique: true, sparse: true },
  password: String,
  username: { type: String, index: true },
  lastUsernameChange: { type: Date },
  displayName: String,
  name: String,
  userType: { type: String, default: 'registered' },
  emailVerified: { type: Boolean, default: false },
  // Profile fields
  bio: { type: String, maxlength: 1000 },
  age: { type: Number },
  gender: { type: String },
  dob: { type: Date },
  location: { type: String },
  avatar: { type: String },
  photoURL: { type: String },
  // Preferences / settings
  settings: {
    notifications: {
      messages: { type: Boolean, default: true },
      mentions: { type: Boolean, default: true },
      groupInvites: { type: Boolean, default: true },
      systemUpdates: { type: Boolean, default: false },
      soundEnabled: { type: Boolean, default: true },
      vibrationEnabled: { type: Boolean, default: true },
      alertVolume: { type: Number, default: 80 }
    },
    privacy: {
      profileVisibility: { type: String, enum: ['public', 'friends', 'private'], default: 'public' },
      showOnlineStatus: { type: Boolean, default: true },
      allowDirectMessages: { type: Boolean, default: true },
      showReadReceipts: { type: Boolean, default: true },
      dmScope: { type: String, enum: ['everyone', 'friends'], default: 'everyone' },
      profilePhotoVisibility: { type: String, enum: ['everyone', 'friends'], default: 'everyone' }
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
  friends: [{ type: String }],
  blockedUsers: [{ type: String }],
  lastIp: String,
  lastActive: Date,
  // Presence
  isOnline: { type: Boolean, default: false },
  lastSeen: { type: Date },
  // Premium / subscription
  isPremium: { type: Boolean, default: false },
  premiumUntil: { type: Date },
  subscription: {
    provider: { type: String },
    orderId: { type: String },
    plan: { type: String },
    amount: { type: String }
  },
  resetToken: String,
  resetTokenExpires: Number,
  emailVerificationToken: String,
  emailVerificationTokenExpires: Number,
  deletePending: Boolean,
  deleteRequestedAt: Number,
  deleteScheduledFor: Number,
  createdAt: { type: Date, default: Date.now }
  });

  // Ensure displayName is unique across all users (case-insensitive). Run migration first to resolve existing duplicates.
  UserSchema.index({ displayName: 1 }, { unique: true, collation: { locale: 'en', strength: 2 }, sparse: true });

  export default mongoose.models.User || mongoose.model('User', UserSchema);
