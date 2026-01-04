import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDb() {
  try {
    await mongoose.connect(env.mongoUri, {
      autoIndex: true
    });
    console.log('✅ MongoDB connected');
    try {
      const dbName = mongoose.connection.db.databaseName;
      const cols = await mongoose.connection.db.listCollections().toArray();
      console.log(`ℹ️ Connected database: ${dbName}`);
      console.log('ℹ️ Collections:', cols.map((c) => c.name));
    } catch (e) {
      console.warn('⚠️ Could not list collections', e?.message || e);
    }
  } catch (err) {
    console.error('❌ MongoDB connection error', err.message);
    process.exit(1);
  }
}
