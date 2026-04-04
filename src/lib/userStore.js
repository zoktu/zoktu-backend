import User from '../models/User.js';

// In-memory maps used by the existing routes; we'll seed them from MongoDB
export const users = new Map(); // keyed by email (for registered accounts)
export const guestUsernames = new Map();

export function updateUserPresenceInMemory(userId, isOnline) {
  const id = String(userId || '').trim();
  if (!id) return;

  const nextIsOnline = Boolean(isOnline);
  const nextLastSeen = nextIsOnline ? undefined : new Date();

  let matchedAny = false;
  for (const [key, value] of users.entries()) {
    if (!value) continue;
    const entryId = value.id || value._id || '';
    const entryGuestId = value.guestId || '';
    if (String(entryId) !== id && String(entryGuestId) !== id) continue;
    matchedAny = true;

    const updated = {
      ...value,
      isOnline: nextIsOnline,
      ...(nextLastSeen ? { lastSeen: nextLastSeen } : {})
    };
    users.set(key, updated);
  }

  // If this id is not yet in-memory but is now online, add a minimal entry
  // so /users?online=true can immediately include it.
  if (!matchedAny && nextIsOnline) {
    const fallback = {
      id,
      guestId: id,
      displayName: id,
      name: id,
      username: id,
      userType: 'guest',
      isOnline: true
    };
    users.set(id, fallback);
  }
}

export function upsertUserInMemory(docOrUser, persist = false) {
  if (!docOrUser) return null;
  const id = String(docOrUser._id || docOrUser.id || '').trim();
  const guestId = docOrUser.guestId ? String(docOrUser.guestId) : null;
  const email = docOrUser.email ? String(docOrUser.email) : null;

  const entry = {
    ...docOrUser,
    id: id || (guestId || email || undefined)
  };

  try {
    if (email) users.set(email, entry);
    if (guestId) users.set(guestId, entry);
    if (id) users.set(id, entry);
    if (entry.id) users.set(String(entry.id), entry);
  } catch (e) {
    // ignore
  }

  try {
    if (guestId && entry.displayName) {
      guestUsernames.set(String(entry.displayName).toLowerCase(), guestId);
    }
  } catch (e) {
    // ignore
  }

  if (persist) {
    persistUserToDb(entry).catch(() => null);
  }

  return entry;
}

export async function seedUsersFromDb() {
  try {
    // Reset all ghost online statuses from previous sessions
    await User.updateMany({ isOnline: true }, { $set: { isOnline: false } }).exec();
  } catch (e) {
    console.warn('⚠️ Failed to reset online statuses on startup', e);
  }
  const docs = await User.find({}).lean().exec();
  docs.forEach((doc) => {
    upsertUserInMemory({ ...doc, isOnline: false, id: String(doc._id) });
  });
}

export async function persistUserToDb(user) {
  if (!user) return null;
  // Only persist registered accounts (those with email)
  const data = { ...user };
  delete data.id;

  // Prevent empty string emails from breaking the MongoDB unique index
  if (data.email === '') {
    delete data.email;
  }

  // Keep profile photo fields consistent across the codebase.
  // Some UI writes `photoURL`, others write `avatar`.
  if (data.photoURL === null || data.avatar === null) {
    data.photoURL = null;
    data.avatar = null;
  }
  if (!data.avatar && data.photoURL) data.avatar = data.photoURL;
  if (!data.photoURL && data.avatar) data.photoURL = data.avatar;

  // Make sure username is persisted; many UI places render @username.
  // If missing, fall back to displayName (especially for guests).
  if (!data.username) {
    if (data.displayName) data.username = data.displayName;
    else if (data.name) data.username = data.name;
    else if (data.email) data.username = String(data.email).split('@')[0];
  }
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
