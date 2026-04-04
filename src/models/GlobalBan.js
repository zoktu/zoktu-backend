import mongoose from 'mongoose';

const GlobalBanSchema = new mongoose.Schema({
  userId: { type: String, index: true, sparse: true },
  ip: { type: String, index: true, sparse: true },
  reason: { type: String, default: 'Violated terms of service' },
  bannedBy: { type: String }, // e.g., email or userId of the superadmin
  expiresAt: { type: Date }, // null if permanent
  createdAt: { type: Date, default: Date.now }
});

// Compound index for unique ban pairs if needed, or just individual indexes.
// We allow multiple bans per IP/User for logging history, but the middleware 
// will check for any active ban.

export default mongoose.models.GlobalBan || mongoose.model('GlobalBan', GlobalBanSchema);
