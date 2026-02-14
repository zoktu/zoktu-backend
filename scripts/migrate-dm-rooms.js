#!/usr/bin/env node
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import Room from '../src/models/Room.js';
import DMRoom from '../src/models/DMRoom.js';

const args = process.argv.slice(2);
const hasArg = (flag) => args.includes(flag);
const getArgValue = (prefix) => {
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

const dryRun = !hasArg('--apply');
const deleteSource = hasArg('--delete-source');
const limit = Number(getArgValue('--limit=')) || 0;

if (deleteSource && dryRun) {
  console.warn('Ignoring --delete-source because --apply was not set.');
}

const dmFilter = {
  $or: [
    { type: 'dm' },
    { category: 'dm' },
    { type: 'private', category: 'dm' }
  ]
};

const normalizeRoomDoc = (doc) => {
  if (!doc) return null;
  const { _id, __v, ...rest } = doc;
  if (!rest.category) rest.category = 'dm';
  if (!rest.type) rest.type = 'private';
  return { _id, rest };
};

const run = async () => {
  console.log('Using MONGO_URI:', process.env.MONGO_URI || env.mongoUri);
  await connectDb();

  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let deleted = 0;
  let errors = 0;

  const cursor = Room.find(dmFilter).lean().cursor();

  for await (const doc of cursor) {
    if (limit && processed >= limit) break;
    processed += 1;

    try {
      const normalized = normalizeRoomDoc(doc);
      if (!normalized) {
        skipped += 1;
        continue;
      }

      const existing = await DMRoom.findById(normalized._id).lean().catch(() => null);
      const srcUpdatedAt = doc?.updatedAt ? new Date(doc.updatedAt).getTime() : 0;
      const dstUpdatedAt = existing?.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
      const shouldUpdate = !existing || srcUpdatedAt > dstUpdatedAt;

      if (dryRun) {
        if (!existing) inserted += 1;
        else if (shouldUpdate) updated += 1;
        else skipped += 1;
        continue;
      }

      if (shouldUpdate) {
        await DMRoom.updateOne(
          { _id: normalized._id },
          { $set: normalized.rest },
          { upsert: true }
        ).exec();
        if (!existing) inserted += 1;
        else updated += 1;
      } else {
        skipped += 1;
      }

      if (deleteSource && !dryRun) {
        await Room.deleteOne({ _id: normalized._id }).exec();
        deleted += 1;
      }
    } catch (err) {
      errors += 1;
      console.error('Failed to migrate DM room', doc?._id, err?.message || err);
    }
  }

  console.log('Migration complete', {
    dryRun,
    processed,
    inserted,
    updated,
    skipped,
    deleted,
    errors
  });

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('Migration failed', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
