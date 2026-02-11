import mongoose from 'mongoose';
import { connectDb } from '../src/config/db.js';
import User from '../src/models/User.js';

const args = new Set(process.argv.slice(2));
const dryRun = !args.has('--apply');

const normalizeKey = (value) => {
  if (!value) return null;
  return String(value).trim().toLowerCase();
};

const addToMap = (map, key, user) => {
  if (!key) return;
  const list = map.get(key) || [];
  list.push(user);
  map.set(key, list);
};

const pickSingle = (map, key) => {
  const list = map.get(key) || [];
  if (list.length === 1) return { user: list[0], conflict: false };
  if (list.length > 1) return { user: null, conflict: true };
  return { user: null, conflict: false };
};

const run = async () => {
  await connectDb();

  const registeredUsers = await User.find({ userType: { $ne: 'guest' } })
    .select('_id displayName username name guestId email userType')
    .lean()
    .exec();

  const registeredMap = new Map();
  registeredUsers.forEach((u) => {
    addToMap(registeredMap, normalizeKey(u.displayName), u);
    addToMap(registeredMap, normalizeKey(u.username), u);
    addToMap(registeredMap, normalizeKey(u.name), u);
    addToMap(registeredMap, normalizeKey(u.email), u);
  });

  const guests = await User.find({ userType: 'guest' })
    .select('_id guestId displayName username name email userType')
    .lean()
    .exec();

  let updated = 0;
  let removed = 0;
  let skipped = 0;
  let conflicts = 0;

  for (const guest of guests) {
    const keys = [
      normalizeKey(guest.displayName),
      normalizeKey(guest.username),
      normalizeKey(guest.name),
      normalizeKey(guest.email)
    ].filter(Boolean);

    let match = null;
    let conflict = false;

    for (const key of keys) {
      const result = pickSingle(registeredMap, key);
      if (result.conflict) {
        conflict = true;
        break;
      }
      if (result.user) {
        match = result.user;
        break;
      }
    }

    if (conflict) {
      conflicts += 1;
      skipped += 1;
      console.log('CONFLICT: multiple registered matches for guest', {
        guestId: guest.guestId,
        displayName: guest.displayName
      });
      continue;
    }

    if (!match) {
      skipped += 1;
      continue;
    }

    if (guest.guestId && match.guestId && String(match.guestId) !== String(guest.guestId)) {
      conflicts += 1;
      skipped += 1;
      console.log('CONFLICT: registered user already has different guestId', {
        guestId: guest.guestId,
        registeredGuestId: match.guestId,
        displayName: guest.displayName
      });
      continue;
    }

    if (dryRun) {
      if (guest.guestId && !match.guestId) updated += 1;
      removed += 1;
      console.log('DRY RUN: would merge + remove guest', {
        guestId: guest.guestId,
        displayName: guest.displayName,
        registeredId: match._id
      });
      continue;
    }

    if (guest.guestId && !match.guestId) {
      await User.updateOne({ _id: match._id }, { $set: { guestId: guest.guestId } }).exec();
      updated += 1;
    }

    await User.deleteOne({ _id: guest._id }).exec();
    removed += 1;
  }

  console.log('Cleanup complete', { dryRun, updated, removed, skipped, conflicts });
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error('Cleanup failed', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
