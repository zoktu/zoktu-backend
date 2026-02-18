import mongoose from 'mongoose';

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, index: true, unique: true },
  paymentSessionId: { type: String },
  checkoutUrl: { type: String },
  amount: { type: String },
  currency: { type: String, default: 'INR' },
  customerId: { type: String },
  customerEmail: { type: String },
  customerPhone: { type: String },
  username: { type: String },
  idempotencyKey: { type: String, index: true, sparse: true },
  plan: { type: String },
  status: { type: String, enum: ['PENDING','PAID','FAILED','REFUNDED'], default: 'PENDING' },
  rawResponse: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date }
});

OrderSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.models.Order || mongoose.model('Order', OrderSchema);
