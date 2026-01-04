#!/usr/bin/env node
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';

// Minimal User model shape for migration
const userSchema = new mongoose.Schema({}, { strict: false, collection: 'users' });
const User = mongoose.model('User_migration', userSchema);

async function run() {
  await mongoose.connect(env.mongoUri, { dbName: env.dbName, useNewUrlParser: true, useUnifiedTopology: true });
  console.log('Connected to DB');

  // Aggregate duplicates by displayName (case-insensitive)
  const duplicates = await User.aggregate([
    { $match: { displayName: { $exists: true, $ne: null } } },
    { $group: { _id: { $toLower: '$displayName' }, ids: { $push: '$_id' }, docs: { $push: '$$ROOT' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]).allowDiskUse(true);

  console.log(`Found ${duplicates.length} duplicate displayName groups`);

  for (const grp of duplicates) {
    // Prefer keeping a registered user if present, otherwise keep the earliest created
    const docs = grp.docs.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    let keeperIndex = docs.findIndex(d => (d.userType === 'registered' || d.settings?.userType === 'registered'));
    if (keeperIndex === -1) keeperIndex = 0;

    const keeper = docs[keeperIndex];
    console.log(`Keeping ${keeper._id} (${keeper.displayName})`);

    // For others, if guest -> rename; if registered collision (rare) -> append suffix
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (doc._id.toString() === keeper._id.toString()) continue;

      let newNameBase = doc.displayName || ('user' + doc._id.toString().slice(-4));
      let suffix = 1;
      let candidate = `${newNameBase}_${suffix}`;

      // ensure uniqueness
      while (await User.findOne({ displayName: { $regex: `^${candidate}$`, $options: 'i' } })) {
        suffix++;
        candidate = `${newNameBase}_${suffix}`;
      }

      await User.updateOne({ _id: doc._id }, { $set: { displayName: candidate } });
      console.log(`Renamed ${doc._id} -> ${candidate}`);
    }
  }

  console.log('Done.');
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
