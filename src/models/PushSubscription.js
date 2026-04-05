import mongoose from 'mongoose';

const PushSubscriptionSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  userAliases: [{ type: String, index: true }],
  subscription: {
    endpoint: { type: String, required: true },
    expirationTime: { type: Number, default: null },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true }
    }
  },
  userAgent: { type: String, default: '' },
  deviceId: { type: String, default: '' },
  disabledAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  lastFailureAt: { type: Date, default: null },
  failureReason: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

PushSubscriptionSchema.index({ 'subscription.endpoint': 1 }, { unique: true });
PushSubscriptionSchema.index({ userAliases: 1, disabledAt: 1 });

PushSubscriptionSchema.pre('save', function preSave(next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.models.PushSubscription || mongoose.model('PushSubscription', PushSubscriptionSchema);
