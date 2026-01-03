import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDb() {
  try {
    await mongoose.connect(env.mongoUri, {
      autoIndex: true
    });
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection error', err.message);
    process.exit(1);
  }
}
