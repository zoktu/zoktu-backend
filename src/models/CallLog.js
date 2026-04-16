import mongoose from 'mongoose';

const CallLogSchema = new mongoose.Schema({
  callId: { type: String, required: true, index: true },
  callerId: { type: String, required: true, index: true },
  receiverId: { type: String, required: true, index: true },
  roomId: { type: String, index: true },
  type: { type: String, enum: ['voice', 'video'], required: true },
  status: { 
    type: String, 
    enum: ['ongoing', 'completed', 'missed', 'rejected', 'busy', 'cancelled'], 
    default: 'missed' 
  },
  startTime: { type: Date },
  endTime: { type: Date },
  duration: { type: Number, default: 0 }, // in seconds
  createdAt: { type: Date, default: Date.now, index: { expires: 30 * 24 * 60 * 60 } } // auto-delete after 30 days
}, { timestamps: true });

export default mongoose.models.CallLog || mongoose.model('CallLog', CallLogSchema);
