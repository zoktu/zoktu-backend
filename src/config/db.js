import mongoose from 'mongoose';
import { env } from './env.js';
import dns from 'dns';

// Use Google's public DNS to fix local loopback DNS issues causing querySrv ECONNREFUSED
try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
  // Ignore or log silently
}

export async function connectDb() {
  try {
    const toNum = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };

    const dbMaxPoolSize = toNum(env.dbMaxPoolSize, 40);
    const dbMinPoolSize = toNum(env.dbMinPoolSize, 5);
    const dbServerSelectionTimeoutMs = toNum(env.dbServerSelectionTimeoutMs, 10000);
    const dbSocketTimeoutMs = toNum(env.dbSocketTimeoutMs, 45000);
    const dbAutoIndex = String(env.dbAutoIndex || '').trim().toLowerCase();

    await mongoose.connect(env.mongoUri, {
      autoIndex: dbAutoIndex
        ? ['1', 'true', 'yes', 'on'].includes(dbAutoIndex)
        : env.nodeEnv !== 'production',
      maxPoolSize: dbMaxPoolSize,
      minPoolSize: dbMinPoolSize,
      serverSelectionTimeoutMS: dbServerSelectionTimeoutMs,
      socketTimeoutMS: dbSocketTimeoutMs
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
