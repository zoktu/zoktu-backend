import User from '../models/User.js';

// In-memory maps used by the existing routes; we'll seed them from MongoDB
export const users = new Map(); // keyed by email (for registered accounts)
export const guestUsernames = new Map();

export async function seedUsersFromDb() {
  const docs = await User.find({}).lean().exec();
  docs.forEach((doc) => {
    const entry = { ...doc, id: String(doc._id) };
    if (doc.email) users.set(doc.email, entry);
    if (doc.guestId) users.set(doc.guestId, entry);
    // also index by Mongo _id string for identifier lookups
    users.set(String(doc._id), entry);
    // index guest username -> guestId for availability checks
    if (doc.guestId && doc.displayName) {
      guestUsernames.set(doc.displayName.toLowerCase(), doc.guestId);
    }
  });
}

export async function persistUserToDb(user) {
  if (!user) return null;
  // Only persist registered accounts (those with email)
  const data = { ...user };
  delete data.id;
  try {
    if (user.email) {
      const saved = await User.findOneAndUpdate({ email: user.email }, data, { upsert: true, new: true }).lean().exec();
      console.log('🔁 persistUserToDb saved registered user:', saved && { email: saved.email, _id: saved._id });
      return saved;
    }

    // persist guests by guestId
    if (user.id) {
      const guestId = user.id;
      data.guestId = guestId;
      const saved = await User.findOneAndUpdate({ guestId }, data, { upsert: true, new: true }).lean().exec();
      console.log('🔁 persistUserToDb saved guest:', saved && { guestId: saved.guestId, displayName: saved.displayName, _id: saved._id });
      return saved;
    }

    console.warn('persistUserToDb: nothing to persist (no email or id)', { user });
    return null;
  } catch (err) {
    console.error('persistUserToDb error:', err && err.message ? err.message : err);
    throw err;
  }
}
