import mongoose from 'mongoose';
import { connectDb } from '../src/config/db.js';
import { RoomMessage, DMMessage, RandomMessage } from '../src/models/Message.js';
import { encryptMessageContent, isEncryptedMessageContent } from '../src/lib/messageCrypto.js';

const BATCH_SIZE = 200;

const migrateModel = async (Model, label) => {
  let scanned = 0;
  let updated = 0;

  const cursor = Model.find({}, { _id: 1, content: 1 }).lean().cursor();
  let ops = [];

  for await (const doc of cursor) {
    scanned += 1;
    const current = String(doc?.content ?? '');
    if (!current || isEncryptedMessageContent(current)) continue;

    const encrypted = encryptMessageContent(current);
    if (!encrypted || encrypted === current) continue;

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { content: encrypted } }
      }
    });

    if (ops.length >= BATCH_SIZE) {
      const result = await Model.bulkWrite(ops, { ordered: false });
      updated += Number(result?.modifiedCount || 0);
      ops = [];
    }
  }

  if (ops.length) {
    const result = await Model.bulkWrite(ops, { ordered: false });
    updated += Number(result?.modifiedCount || 0);
  }

  console.log(`✅ ${label}: scanned=${scanned}, encrypted=${updated}`);
  return { scanned, updated };
};

(async () => {
  try {
    await connectDb();

    await migrateModel(RoomMessage, 'room_messages');
    await migrateModel(DMMessage, 'dm_messages');
    await migrateModel(RandomMessage, 'random_messages');

    console.log('🎉 Message encryption migration completed.');
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Message encryption migration failed:', error?.message || error);
    try {
      await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
  }
})();
