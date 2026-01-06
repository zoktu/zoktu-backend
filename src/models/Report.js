import mongoose from 'mongoose';

const ReportSchema = new mongoose.Schema({
  reporterId: { type: String, required: true, index: true },
  targetMessageId: { type: String, index: true },
  targetUserId: { type: String, index: true },
  roomId: { type: String, index: true },
  reason: { type: String, default: 'unspecified' },
  details: { type: String },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.Report || mongoose.model('Report', ReportSchema, 'reports');
