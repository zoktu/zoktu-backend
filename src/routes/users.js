import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { users, persistUserToDb } from '../lib/userStore.js';
import User from '../models/User.js';
import { containsProfanity } from '../middleware/profanityFilter.js';

const router = Router();

const uniqStrings = (arr) => Array.from(new Set((arr || []).filter(Boolean).map((v) => String(v))));

const isUserOnline = (u) => {
  const v = u?.isOnline;
  return v === true || v === 'true' || v === 1 || v === '1';
};

const uniqUsers = (list) => {
  const byKey = new Map();
  for (const u of list || []) {
    if (!u) continue;
    const key = String(u.id || u.guestId || u._id || u.email || u.displayName || '').trim();
    if (!key) continue;

    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, u);
      continue;
    }

    // Prefer an online snapshot over an offline duplicate.
    const prevOnline = Boolean(prev?.isOnline);
    const nextOnline = Boolean(u?.isOnline);

    if (!prevOnline && nextOnline) {
      byKey.set(key, { ...prev, ...u, isOnline: true });
      continue;
    }

    if (prevOnline && !nextOnline) {
      byKey.set(key, { ...u, ...prev, isOnline: true });
      continue;
    }

    // If both have same online status, keep the richer merged object.
    byKey.set(key, { ...prev, ...u, isOnline: prevOnline || nextOnline });
  }
  return Array.from(byKey.values());
};

const matchesSearch = (u, termLower) => {
  const fields = [u.displayName, u.username, u.name, u.email, u.guestId, u.id];
  return fields.some((v) => (v ? String(v).toLowerCase().includes(termLower) : false));
};

const getAuthPayload = (req) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return null;
    return jwt.verify(token, env.jwtSecret);
  } catch (e) {
    return null;
  }
};

const looksLikeObjectId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));

const getViewerIdsFromReq = async (req) => {
  const payload = getAuthPayload(req);
  const ids = new Set();
  if (!payload) return ids;

  if (payload.id) ids.add(String(payload.id));
  if (payload.guestId) ids.add(String(payload.guestId));
  if (payload.userId) ids.add(String(payload.userId));
  if (payload._id) ids.add(String(payload._id));

  const or = [];
  if (payload.email) or.push({ email: String(payload.email) });
  if (payload.id) {
    or.push({ guestId: String(payload.id) });
    if (looksLikeObjectId(payload.id)) or.push({ _id: String(payload.id) });
  }
  if (payload.guestId) or.push({ guestId: String(payload.guestId) });
  if (payload.userId) or.push({ guestId: String(payload.userId) });
  if (payload._id) or.push({ _id: String(payload._id) });

  if (or.length) {
    try {
      const doc = await User.findOne({ $or: or }).select('_id guestId').lean().exec().catch(() => null);
      if (doc?._id) ids.add(String(doc._id));
      if (doc?.guestId) ids.add(String(doc.guestId));
    } catch (e) {
      // ignore
    }
  }

  return ids;
};

const shouldHideProfilePhoto = ({ viewerIds, targetUser }) => {
  if (!targetUser) return false;
  const visibility =
    targetUser?.settings?.privacy?.profilePhotoVisibility ||
    targetUser?.settings?.profilePhotoVisibility ||
    'everyone';

  if (visibility !== 'friends') return false;

  const targetIds = uniqStrings([targetUser.id, targetUser._id, targetUser.guestId]);
  const viewer = new Set(uniqStrings(Array.from(viewerIds || [])));
  const isSelf = targetIds.some((tid) => viewer.has(String(tid)));
  if (isSelf) return false;

  const friends = Array.isArray(targetUser?.friends) ? targetUser.friends.map(String).filter(Boolean) : [];
  const canSee = Array.from(viewer).some((vid) => friends.includes(String(vid)));
  return !canSee;
};

const filterUserForViewer = ({ viewerIds, user }) => {
  if (!user) return user;
  if (!shouldHideProfilePhoto({ viewerIds, targetUser: user })) return user;
  return { ...user, avatar: null, photoURL: null };
};

// Return all users known in-memory (seeded from DB at startup)
router.get('/', asyncHandler(async (req, res) => {
  const online = req.query?.online;
  let raw = Array.from(users.values());

  // For online listings, also merge DB-backed users to avoid in-memory drift.
  if (online === true || online === 'true' || online === 1 || online === '1') {
    try {
      const onlineDocs = await User.find({ isOnline: true }).lean().exec().catch(() => []);
      const normalized = (onlineDocs || []).map((doc) => ({
        ...doc,
        id: String(doc?.guestId || doc?._id || '')
      }));
      raw = [...raw, ...normalized];
    } catch (e) {
      // ignore DB fallback failures
    }
  }

  const unique = uniqUsers(raw);

  const viewerIds = await getViewerIdsFromReq(req);

  const search = (req.query?.search || '').toString().trim();
  // Resolve "me" from Authorization (best-effort) so we can exclude it from search results.
  let meEmail = null;
  let meId = null;
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      const payload = jwt.verify(token, env.jwtSecret);
      meEmail = payload?.email ? String(payload.email) : null;
      meId = payload?.id ? String(payload.id) : null;
    }
  } catch (e) {
    // ignore
  }

  // If searching, never return everyone
  if (search) {
    if (search.length < 2) return res.json([]);
    const termLower = search.toLowerCase();
    const filtered = unique
      .filter((u) => matchesSearch(u, termLower))
      .filter((u) => {
        if (!u) return false;
        if (meEmail && u.email && String(u.email).toLowerCase() === String(meEmail).toLowerCase()) return false;
        if (meId && u.id && String(u.id) === String(meId)) return false;
        return true;
      });
    return res.json(filtered.slice(0, 25).map((u) => filterUserForViewer({ viewerIds, user: u })));
  }

  // Optional: filter online users
  if (online === true || online === 'true' || online === 1 || online === '1') {
    return res.json(unique.filter((u) => isUserOnline(u)).map((u) => filterUserForViewer({ viewerIds, user: u })));
  }

  res.json(unique.map((u) => filterUserForViewer({ viewerIds, user: u })));
}));

// Get user by id (uses in-memory map seeded from DB)
router.get('/:id', asyncHandler(async (req, res) => {
  const viewerIds = await getViewerIdsFromReq(req);
  const requestedId = String(req.params.id || '').trim();

  if (requestedId && env.botId && requestedId === String(env.botId)) {
    const botName = String(env.botName || 'Bot');
    const botAvatar = String(env.botAvatar || '').trim();
    const existing = users.get(requestedId) || null;
    const botProfile = {
      ...(existing || {}),
      id: requestedId,
      guestId: requestedId,
      displayName: botName,
      name: botName,
      username: botName,
      ...(botAvatar ? { avatar: botAvatar, photoURL: botAvatar } : {}),
      userType: 'guest',
      isOnline: true
    };
    users.set(requestedId, botProfile);
    return res.json(filterUserForViewer({ viewerIds, user: botProfile }));
  }

  let user = users.get(req.params.id) || null;
  if (user) return res.json(filterUserForViewer({ viewerIds, user }));

  // DB fallback (important for blockedUsers/friends persistence)
  try {
    const id = String(req.params.id);
    const doc = await User.findOne({ $or: [{ _id: id }, { guestId: id }] }).lean().exec().catch(() => null);
    if (doc) {
      const derivedUsername = doc.username || doc.displayName || doc.name || (doc.email ? String(doc.email).split('@')[0] : undefined);
      const entry = { ...doc, id: String(doc._id), username: derivedUsername };
      if (doc.email) users.set(doc.email, entry);
      if (doc.guestId) users.set(doc.guestId, entry);
      users.set(String(doc._id), entry);

      // Best-effort: persist username if missing so it survives future refreshes.
      try {
        if (!doc.username && derivedUsername) {
          await User.updateOne({ _id: doc._id }, { $set: { username: String(derivedUsername) } }).exec();
        }
      } catch (e) {
        // ignore
      }
      return res.json(filterUserForViewer({ viewerIds, user: entry }));
    }
  } catch (e) {
    // ignore
  }

  // Final fallback
  const fallback = { id: req.params.id, displayName: 'Guest', userType: 'guest' };
  users.set(req.params.id, fallback);
  return res.json(filterUserForViewer({ viewerIds, user: fallback }));
}));

const getAuthedUserDoc = async (payload, userIdParam) => {
  // Prefer registered accounts by email; otherwise resolve by id/guestId.
  try {
    if (payload?.email) {
      const doc = await User.findOne({ email: String(payload.email) }).lean().exec().catch(() => null);
      if (doc) return doc;
    }
  } catch (e) {}

  const id = String(userIdParam || payload?.id || '').trim();
  if (!id) return null;
  try {
    return await User.findOne({ $or: [{ _id: id }, { guestId: id }] }).lean().exec().catch(() => null);
  } catch (e) {
    return null;
  }
};

const canonicalBlockedId = async (rawId) => {
  const id = String(rawId || '').trim();
  if (!id) return null;
  try {
    const doc = await User.findOne({ $or: [{ _id: id }, { guestId: id }] }).select('_id guestId userType').lean().exec().catch(() => null);
    if (!doc) return id;
    if (doc.userType === 'guest' && doc.guestId) return String(doc.guestId);
    if (doc._id) return String(doc._id);
    return id;
  } catch (e) {
    return id;
  }
};

const expandUserIdEquivalents = async (rawId) => {
  const id = String(rawId || '').trim();
  const set = new Set();
  if (!id) return set;
  set.add(id);
  try {
    const doc = await User.findOne({ $or: [{ _id: id }, { guestId: id }] }).select('_id guestId').lean().exec().catch(() => null);
    if (doc?._id) set.add(String(doc._id));
    if (doc?.guestId) set.add(String(doc.guestId));
  } catch (e) {}
  return set;
};

const syncUserStoreEntry = (doc) => {
  try {
    if (!doc) return;
    const entry = { ...doc, id: String(doc._id) };
    if (doc.email) users.set(doc.email, entry);
    if (doc.guestId) users.set(doc.guestId, entry);
    users.set(String(doc._id), entry);
  } catch (e) {}
};

const authMatchesUserId = async (payload, userIdParam) => {
  if (!payload) return false;
  const param = String(userIdParam || '');
  if (!param) return false;

  // direct match
  if (payload.id && String(payload.id) === param) return true;
  if (payload.userId && String(payload.userId) === param) return true;
  if (payload._id && String(payload._id) === param) return true;
  if (payload.guestId && String(payload.guestId) === param) return true;

  // email -> resolve user
  try {
    if (payload.email) {
      const u = await User.findOne({ email: String(payload.email) }).select('_id guestId').lean().catch(() => null);
      if (u?._id && String(u._id) === param) return true;
      if (u?.guestId && String(u.guestId) === param) return true;
    }
  } catch (e) {}

  // payload.id might be an object id -> resolve user
  try {
    if (payload.id && looksLikeObjectId(payload.id)) {
      const u = await User.findById(String(payload.id)).select('_id guestId').lean().catch(() => null);
      if (u?._id && String(u._id) === param) return true;
      if (u?.guestId && String(u.guestId) === param) return true;
    }
  } catch (e) {}

  return false;
};

// Record a profile view: body may include `viewerId` (who viewed)
router.post('/:id/view', asyncHandler(async (req, res) => {
  const targetId = req.params.id;
  const viewerId = req.body.viewerId || null;

  let user = users.get(targetId) || { id: targetId };

  // initialize counters if missing
  user.profileViews = user.profileViews || { count: 0 };
  user._profileViewers = user._profileViewers || {}; // in-memory set to avoid double-counting in runtime

  // count unique viewer if provided
  if (viewerId) {
    if (!user._profileViewers[viewerId]) {
      user._profileViewers[viewerId] = Date.now();
      user.profileViews.count = (user.profileViews.count || 0) + 1;
    }
  } else {
    // anonymous view: just increment total
    user.profileViews.count = (user.profileViews.count || 0) + 1;
  }

  users.set(targetId, user);
  try {
    await persistUserToDb(user);
  } catch (e) {
    console.warn('Could not persist profile view', e?.message || e);
  }

  res.json({ profileViews: user.profileViews.count });
}));

// Record chat activity for a user: increments message counts and updates streak/level
router.post('/:id/activity/message', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const messages = Number(req.body.count || 1);
  const now = Date.now();

  let user = users.get(userId) || { id: userId };
  user.chatStats = user.chatStats || { totalMessages: 0, lastChatAt: null, consecutiveDays: 0, level: 0 };

  // increment total messages
  user.chatStats.totalMessages = (user.chatStats.totalMessages || 0) + messages;

  // update consecutive days: if lastChatAt is yesterday or today, increment; if older, reset
  const last = user.chatStats.lastChatAt ? new Date(user.chatStats.lastChatAt) : null;
  const lastDay = last ? new Date(last.getFullYear(), last.getMonth(), last.getDate()) : null;
  const today = new Date();
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  if (!lastDay) {
    user.chatStats.consecutiveDays = 1;
  } else {
    const diffMs = todayDay.getTime() - lastDay.getTime();
    const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
    if (diffDays === 0) {
      // already chatted today; leave consecutiveDays as-is
    } else if (diffDays === 1) {
      user.chatStats.consecutiveDays = (user.chatStats.consecutiveDays || 0) + 1;
    } else {
      user.chatStats.consecutiveDays = 1;
    }
  }

  user.chatStats.lastChatAt = now;

  // simple leveling: every 5 consecutive days or every 500 messages increases level
  const levelFromDays = Math.floor((user.chatStats.consecutiveDays || 0) / 5);
  const levelFromMessages = Math.floor((user.chatStats.totalMessages || 0) / 500);
  user.chatStats.level = Math.max(levelFromDays, levelFromMessages);

  users.set(userId, user);
  try {
    await persistUserToDb(user);
  } catch (e) {
    console.warn('Could not persist chat activity', e?.message || e);
  }

  res.json({ chatStats: user.chatStats });
}));

// Update user and persist to MongoDB
router.patch('/:id', asyncHandler(async (req, res) => {
  const userIdParam = String(req.params.id);
  let existing = users.get(userIdParam) || { id: userIdParam };

  // Best-effort DB read so lock survives stale in-memory entries.
  try {
    const doc = await User.findOne({ $or: [{ _id: userIdParam }, { guestId: userIdParam }, { email: userIdParam }] }).lean().exec().catch(() => null);
    if (doc) existing = { ...existing, ...doc, id: String(doc.guestId || doc._id) };
  } catch (e) {
    // ignore
  }

  const incomingNameRaw = req.body?.name;
  const incomingName = typeof incomingNameRaw === 'string' ? incomingNameRaw.trim() : null;
  const currentName = existing?.name ? String(existing.name).trim() : '';
  const wantsNameChange = typeof incomingName === 'string' && incomingName.length > 0 && incomingName !== currentName;

  // Username/name is set only during /auth/signup or /auth/guest.
  // Disallow any attempt to change it via Settings/Profile updates.
  if (wantsNameChange) {
    return res.status(403).json({ message: 'Username cannot be changed from Settings.' });
  }

  // Do not trust client-provided lastUsernameChange.
  const safeBody = { ...(req.body || {}) };
  delete safeBody.lastUsernameChange;

  // Disallow profane content in profile fields like `bio`, `username`, `displayName`.
  try {
    if (typeof safeBody.bio === 'string' && containsProfanity(safeBody.bio)) {
      return res.status(400).json({ message: 'Profile bio contains disallowed content' });
    }
    if (typeof safeBody.username === 'string' && containsProfanity(safeBody.username)) {
      return res.status(400).json({ message: 'Username contains disallowed content' });
    }
    if (typeof safeBody.displayName === 'string' && containsProfanity(safeBody.displayName)) {
      return res.status(400).json({ message: 'Display name contains disallowed content' });
    }
  } catch (e) {
    // fail-open on detection errors
  }

  // Enforce bio length server-side to match frontend (1000 chars)
  if (typeof safeBody.bio === 'string' && safeBody.bio.length > 1000) {
    return res.status(400).json({ message: 'Profile bio must be 1000 characters or less' });
  }

  const wantsClearPhoto =
    Object.prototype.hasOwnProperty.call(safeBody, 'photoURL') &&
    (safeBody.photoURL === null || String(safeBody.photoURL).trim() === '');
  const wantsClearAvatar =
    Object.prototype.hasOwnProperty.call(safeBody, 'avatar') &&
    (safeBody.avatar === null || String(safeBody.avatar).trim() === '');
  if (wantsClearPhoto || wantsClearAvatar) {
    safeBody.photoURL = null;
    safeBody.avatar = null;
  }

  // DOB rules: allow setting only once; age must be 15–99.
  if (Object.prototype.hasOwnProperty.call(safeBody, 'dob')) {
    const incomingDobRaw = safeBody.dob;
    const incomingDobStr = typeof incomingDobRaw === 'string' ? incomingDobRaw.trim() : incomingDobRaw;

    const existingDob = existing?.dob ? new Date(existing.dob) : null;
    const hasExistingDob = !!(existingDob && !Number.isNaN(existingDob.getTime()));

    // If client tries to change DOB after it is set -> forbidden
    if (incomingDobStr && hasExistingDob) {
      const nextDob = new Date(incomingDobStr);
      if (!Number.isNaN(nextDob.getTime()) && nextDob.toISOString().slice(0, 10) !== existingDob.toISOString().slice(0, 10)) {
        return res.status(403).json({ message: 'DOB is locked and cannot be changed.' });
      }
    }

    // If setting DOB for the first time, validate age range
    if (incomingDobStr && !hasExistingDob) {
      const nextDob = new Date(incomingDobStr);
      if (Number.isNaN(nextDob.getTime())) {
        return res.status(400).json({ message: 'Invalid dob' });
      }

      const today = new Date();
      let age = today.getFullYear() - nextDob.getFullYear();
      const monthDiff = today.getMonth() - nextDob.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < nextDob.getDate())) {
        age -= 1;
      }

      if (age < 15 || age > 99) {
        return res.status(400).json({ message: 'DOB must correspond to an age between 15 and 99.' });
      }
    }
  }

  const updated = { ...existing, ...safeBody };
  // Never mutate username lock fields from this endpoint.
  // update in-memory store
  users.set(userIdParam, updated);
  // attempt to persist to DB (non-fatal)
  try {
    const saved = await persistUserToDb(updated);
    if (saved) {
      // saved is a lean Mongo doc - update in-memory store with canonical data
      syncUserStoreEntry(saved);
      return res.json(saved);
    }
  } catch (e) {
    console.warn('Could not persist user update to DB', e?.message || e);
    return res.status(500).json({ message: 'Failed to persist user update', error: e?.message || e });
  }

  // If nothing was saved, respond with the updated in-memory record
  res.json(updated);
}));

router.post('/:id/block', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const blockedUserId = req.body?.blockedUserId ? String(req.body.blockedUserId) : null;
  if (!blockedUserId) return res.status(400).json({ message: 'blockedUserId required' });

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ message: 'Unauthorized' });
  const ok = await authMatchesUserId(payload, userId);
  if (!ok) return res.status(403).json({ message: 'Forbidden' });

  const me = await getAuthedUserDoc(payload, userId);
  if (!me) return res.status(404).json({ message: 'User not found' });

  const canonTarget = await canonicalBlockedId(blockedUserId);
  if (!canonTarget) return res.status(400).json({ message: 'blockedUserId required' });

  const existing = Array.isArray(me.blockedUsers) ? me.blockedUsers.map(String).filter(Boolean) : [];
  const next = existing.includes(canonTarget) ? existing : [...existing, canonTarget];

  try {
    const updated = await User.findByIdAndUpdate(me._id, { $set: { blockedUsers: next } }, { new: true }).lean().exec();
    syncUserStoreEntry(updated);
    return res.json({ message: 'blocked', target: canonTarget, blockedUsers: Array.isArray(updated?.blockedUsers) ? updated.blockedUsers : next });
  } catch (e) {
    return res.status(500).json({ message: 'Failed to persist block', error: e?.message || e });
  }
}));

router.post('/:id/unblock', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const unblockedUserId = req.body?.unblockedUserId ? String(req.body.unblockedUserId) : null;
  if (!unblockedUserId) return res.status(400).json({ message: 'unblockedUserId required' });

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ message: 'Unauthorized' });
  const ok = await authMatchesUserId(payload, userId);
  if (!ok) return res.status(403).json({ message: 'Forbidden' });

  const me = await getAuthedUserDoc(payload, userId);
  if (!me) return res.status(404).json({ message: 'User not found' });

  const canonTarget = await canonicalBlockedId(unblockedUserId);
  const removeSet = await expandUserIdEquivalents(unblockedUserId);
  if (canonTarget) removeSet.add(String(canonTarget));

  const existing = Array.isArray(me.blockedUsers) ? me.blockedUsers.map(String).filter(Boolean) : [];
  const next = existing.filter((id) => !removeSet.has(String(id)));

  try {
    const updated = await User.findByIdAndUpdate(me._id, { $set: { blockedUsers: next } }, { new: true }).lean().exec();
    syncUserStoreEntry(updated);
    return res.json({ message: 'unblocked', target: canonTarget || unblockedUserId, blockedUsers: Array.isArray(updated?.blockedUsers) ? updated.blockedUsers : next });
  } catch (e) {
    return res.status(500).json({ message: 'Failed to persist unblock', error: e?.message || e });
  }
}));

router.post('/:id/friends/remove', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const friendId = req.body?.friendId ? String(req.body.friendId) : null;
  if (!friendId) return res.status(400).json({ message: 'friendId required' });

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ message: 'Unauthorized' });
  const ok = await authMatchesUserId(payload, userId);
  if (!ok) return res.status(403).json({ message: 'Forbidden' });

  const me = await getAuthedUserDoc(payload, userId);
  if (!me) return res.status(404).json({ message: 'User not found' });

  const meId = String(me._id);
  const existing = Array.isArray(me.friends) ? me.friends.map(String).filter(Boolean) : [];
  const next = existing.filter((id) => String(id) !== String(friendId));

  try {
    const updated = await User.findByIdAndUpdate(meId, { $set: { friends: next } }, { new: true }).lean().exec();
    syncUserStoreEntry(updated);
  } catch (e) {
    return res.status(500).json({ message: 'Failed to remove friend', error: e?.message || e });
  }

  // Remove me from friend's list as well (best-effort)
  try {
    await User.updateOne(
      { $or: [{ _id: String(friendId) }, { guestId: String(friendId) }] },
      { $pull: { friends: String(meId) } }
    ).exec();
  } catch (e) {}

  res.json({ message: 'friend removed', target: friendId, friends: next });
}));

export default router;
