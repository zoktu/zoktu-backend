import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { users, persistUserToDb } from '../lib/userStore.js';
import User from '../models/User.js';
import Room from '../models/Room.js';
import DMRoom from '../models/DMRoom.js';
import { containsProfanity } from '../middleware/profanityFilter.js';

const router = Router();

const uniqStrings = (arr) => Array.from(new Set((arr || []).filter(Boolean).map((v) => String(v))));

const isUserOnline = (u) => {
  const v = u?.isOnline;
  return v === true || v === 'true' || v === 1 || v === '1';
};

const userAliasKeys = (u) => {
  if (!u) return [];
  const aliases = uniqStrings([u.id, u.guestId, u._id, u.email]);
  if (aliases.length) return aliases;
  const fallback = String(u.displayName || u.username || u.name || '').trim();
  return fallback ? [fallback] : [];
};

const uniqUsers = (list) => {
  const byKey = new Map();
  const canonicalByAlias = new Map();

  const mergeUsers = (prev, next) => {
    if (!prev) return next;
    if (!next) return prev;

    // Prefer an online snapshot over an offline duplicate.
    const prevOnline = Boolean(prev?.isOnline);
    const nextOnline = Boolean(next?.isOnline);

    if (!prevOnline && nextOnline) {
      return { ...prev, ...next, isOnline: true };
    }

    if (prevOnline && !nextOnline) {
      return { ...next, ...prev, isOnline: true };
    }

    // If both have same online status, keep the richer merged object.
    return { ...prev, ...next, isOnline: prevOnline || nextOnline };
  };

  for (const u of list || []) {
    if (!u) continue;
    const aliases = userAliasKeys(u);
    if (!aliases.length) continue;

    const existingCanonical = aliases.map((alias) => canonicalByAlias.get(alias)).find(Boolean);
    const key = existingCanonical || aliases[0];

    const prev = byKey.get(key);
    byKey.set(key, mergeUsers(prev, u));

    for (const alias of aliases) {
      canonicalByAlias.set(alias, key);
    }
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
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const buildSafeSettingsPatch = (incomingSettings, existingSettings) => {
  const next = {
    notifications: isPlainObject(existingSettings?.notifications) ? { ...existingSettings.notifications } : {},
    privacy: isPlainObject(existingSettings?.privacy) ? { ...existingSettings.privacy } : {},
    appearance: isPlainObject(existingSettings?.appearance) ? { ...existingSettings.appearance } : {}
  };

  if (!isPlainObject(incomingSettings)) {
    if (typeof existingSettings?.language === 'string') next.language = existingSettings.language;
    return next;
  }

  if (isPlainObject(incomingSettings.notifications)) {
    const source = incomingSettings.notifications;
    const boolKeys = ['messages', 'mentions', 'groupInvites', 'systemUpdates', 'soundEnabled', 'vibrationEnabled'];
    for (const key of boolKeys) {
      if (Object.prototype.hasOwnProperty.call(source, key) && typeof source[key] === 'boolean') {
        next.notifications[key] = source[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(source, 'alertVolume')) {
      const volume = Number(source.alertVolume);
      if (Number.isFinite(volume)) {
        next.notifications.alertVolume = Math.min(100, Math.max(0, Math.round(volume)));
      }
    }
  }

  if (isPlainObject(incomingSettings.privacy)) {
    const source = incomingSettings.privacy;
    const boolKeys = ['showOnlineStatus', 'allowDirectMessages', 'showReadReceipts'];
    for (const key of boolKeys) {
      if (Object.prototype.hasOwnProperty.call(source, key) && typeof source[key] === 'boolean') {
        next.privacy[key] = source[key];
      }
    }

    if (Object.prototype.hasOwnProperty.call(source, 'profileVisibility')) {
      const visibility = String(source.profileVisibility || '').trim();
      if (['public', 'friends', 'private'].includes(visibility)) {
        next.privacy.profileVisibility = visibility;
      }
    }

    if (Object.prototype.hasOwnProperty.call(source, 'dmScope')) {
      const dmScope = String(source.dmScope || '').trim();
      if (['everyone', 'friends'].includes(dmScope)) {
        next.privacy.dmScope = dmScope;
      }
    }

    if (Object.prototype.hasOwnProperty.call(source, 'profilePhotoVisibility')) {
      const profilePhotoVisibility = String(source.profilePhotoVisibility || '').trim();
      if (['everyone', 'friends'].includes(profilePhotoVisibility)) {
        next.privacy.profilePhotoVisibility = profilePhotoVisibility;
      }
    }
  }

  if (isPlainObject(incomingSettings.appearance)) {
    const source = incomingSettings.appearance;
    const boolKeys = ['compactMode', 'showAvatars', 'animationsEnabled'];
    for (const key of boolKeys) {
      if (Object.prototype.hasOwnProperty.call(source, key) && typeof source[key] === 'boolean') {
        next.appearance[key] = source[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(source, 'fontSize')) {
      const fontSize = String(source.fontSize || '').trim();
      if (['small', 'medium', 'large'].includes(fontSize)) {
        next.appearance.fontSize = fontSize;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(incomingSettings, 'language')) {
    if (incomingSettings.language === null) {
      next.language = null;
    } else if (typeof incomingSettings.language === 'string') {
      next.language = incomingSettings.language;
    }
  } else if (typeof existingSettings?.language === 'string') {
    next.language = existingSettings.language;
  }

  return next;
};

const buildSafeUserPatch = (incomingBody, existingUser) => {
  const safe = {};
  if (!isPlainObject(incomingBody)) return safe;

  if (Object.prototype.hasOwnProperty.call(incomingBody, 'displayName')) {
    if (incomingBody.displayName === null) {
      safe.displayName = null;
    } else if (typeof incomingBody.displayName === 'string') {
      safe.displayName = incomingBody.displayName;
    }
  }

  if (Object.prototype.hasOwnProperty.call(incomingBody, 'bio')) {
    if (incomingBody.bio === null) {
      safe.bio = null;
    } else if (typeof incomingBody.bio === 'string') {
      safe.bio = incomingBody.bio;
    }
  }

  if (Object.prototype.hasOwnProperty.call(incomingBody, 'age')) {
    if (incomingBody.age === null || incomingBody.age === '') {
      safe.age = null;
    } else {
      const parsedAge = Number(incomingBody.age);
      if (Number.isFinite(parsedAge)) safe.age = Math.round(parsedAge);
    }
  }

  if (Object.prototype.hasOwnProperty.call(incomingBody, 'gender')) {
    if (incomingBody.gender === null) {
      safe.gender = null;
    } else if (typeof incomingBody.gender === 'string') {
      safe.gender = incomingBody.gender;
    }
  }

  if (Object.prototype.hasOwnProperty.call(incomingBody, 'dob')) {
    if (incomingBody.dob === null || incomingBody.dob === '') {
      safe.dob = null;
    } else if (typeof incomingBody.dob === 'string' || incomingBody.dob instanceof Date) {
      safe.dob = incomingBody.dob;
    }
  }

  if (Object.prototype.hasOwnProperty.call(incomingBody, 'location')) {
    if (incomingBody.location === null) {
      safe.location = null;
    } else if (typeof incomingBody.location === 'string') {
      safe.location = incomingBody.location;
    }
  }

  if (Object.prototype.hasOwnProperty.call(incomingBody, 'avatar')) {
    if (incomingBody.avatar === null) {
      safe.avatar = null;
    } else if (typeof incomingBody.avatar === 'string') {
      safe.avatar = incomingBody.avatar;
    }
  }

  if (Object.prototype.hasOwnProperty.call(incomingBody, 'photoURL')) {
    if (incomingBody.photoURL === null) {
      safe.photoURL = null;
    } else if (typeof incomingBody.photoURL === 'string') {
      safe.photoURL = incomingBody.photoURL;
    }
  }

  if (Object.prototype.hasOwnProperty.call(incomingBody, 'settings')) {
    safe.settings = buildSafeSettingsPatch(incomingBody.settings, existingUser?.settings || {});
  }

  return safe;
};

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
  const normalizedRequestedId = requestedId.replace(/^@+/, '');

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

  // Remove early return from cache to ensure stats are always freshly calculated
  const idToResolve = String(normalizedRequestedId || req.params.id || '').trim();
  const idsSet = new Set(await expandUserIdEquivalents(idToResolve));

  // DB fallback (important for blockedUsers/friends persistence)
  try {
    let doc = null;

    if (!doc && looksLikeObjectId(idToResolve)) {
      doc = await User.findById(idToResolve).lean().exec().catch(() => null);
    }
    if (!doc) {
      doc = await User.findOne({ guestId: idToResolve }).lean().exec().catch(() => null);
    }
    if (!doc) {
      doc = await User.findOne({ email: idToResolve }).lean().exec().catch(() => null);
    }
    if (!doc) {
      doc = await User.findOne({ username: idToResolve }).lean().exec().catch(() => null);
    }
    if (!doc) {
      doc = await User.findOne({ displayName: idToResolve }).lean().exec().catch(() => null);
    }
    if (!doc) {
      doc = await User.findOne({ name: idToResolve }).lean().exec().catch(() => null);
    }

    if (!doc && idToResolve) {
      const usernameRegex = new RegExp(`^${escapeRegex(idToResolve)}$`, 'i');
      const caseInsensitiveMatches = await User.find({
        $or: [{ username: usernameRegex }, { displayName: usernameRegex }, { name: usernameRegex }]
      })
        .sort({ _id: -1 })
        .limit(2)
        .lean()
        .exec()
        .catch(() => []);

      if (caseInsensitiveMatches.length === 1) {
        doc = caseInsensitiveMatches[0];
      } else if (caseInsensitiveMatches.length > 1) {
        return res.status(409).json({
          message: 'Ambiguous profile identifier. Please open profile using exact case or userId.'
        });
      }
    }

    if (doc) {
      if (doc?._id) idsSet.add(String(doc._id));
      if (doc?.guestId) idsSet.add(String(doc.guestId));
      if (doc?.email) idsSet.add(String(doc.email));
      if (doc?.username) idsSet.add(String(doc.username));
      const ids = Array.from(idsSet);

      const derivedUsername = doc.username || doc.displayName || doc.name || (doc.email ? String(doc.email).split('@')[0] : undefined);
      
      // Calculate real-time stats (using expanded IDs to match any participant identifier)
      const [roomsCount, dmRoomsCount] = await Promise.all([
        Room.countDocuments({ $or: [{ participants: { $in: ids } }, { members: { $in: ids } }] }),
        DMRoom.countDocuments({ $or: [{ participants: { $in: ids } }, { members: { $in: ids } }] })
      ]);
      const totalRooms = roomsCount + dmRoomsCount;

      const views = (doc.profileViews?.count || 0);
      const msgCount = (doc.chatStats?.totalMessages || 0);
      const level = (doc.chatStats?.level || 0);
      const karma = Math.floor((msgCount / 50) + (level * 10) + (views * 2));

      const entry = { 
        ...doc, 
        id: String(doc._id), 
        username: derivedUsername,
        roomsCount: totalRooms,
        karma: karma 
      };

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

  // Final fallback if DB read fails and user isn't in memory
  let existingMem = users.get(req.params.id);
  if (!existingMem) {
    existingMem = { 
      id: req.params.id, 
      displayName: req.params.id.startsWith('guest-') ? `Guest-${req.params.id.split('-').slice(-1)[0]}` : 'Guest', 
      userType: 'guest',
      roomsCount: 0,
      karma: 0,
      followers: [],
      following: []
    };
    users.set(req.params.id, existingMem);
  }
  return res.json(filterUserForViewer({ viewerIds, user: existingMem }));
}));

const getAuthedUserDoc = async (payload, userIdParam) => {
  // Resolve by email from payload first
  try {
    if (payload?.email) {
      const doc = await User.findOne({ email: String(payload.email) }).lean().exec().catch(() => null);
      if (doc) return doc;
    }
  } catch (e) {}

  const id = String(userIdParam || payload?.id || '').trim();
  if (!id) return null;
  
  // Resolve by any identifier (id, guestId, username, email)
  try {
    return await User.findOne({ 
      $or: [
        { _id: id }, 
        { guestId: id }, 
        { username: id }, 
        { email: id }
      ] 
    }).lean().exec().catch(() => null);
  } catch (e) {
    return null;
  }
};

const canonicalBlockedId = async (rawId) => {
  const id = String(rawId || '').trim();
  if (!id) return null;
  try {
    const doc = await User.findOne({ 
      $or: [
        { _id: id }, 
        { guestId: id }, 
        { username: id }, 
        { email: id }
      ] 
    }).select('_id guestId userType').lean().exec().catch(() => null);
    
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
    const doc = await User.findOne({ 
      $or: [
        { _id: id }, 
        { guestId: id }, 
        { username: id }, 
        { email: id }
      ] 
    }).select('_id guestId email username').lean().exec().catch(() => null);
    if (doc?._id) set.add(String(doc._id));
    if (doc?.guestId) set.add(String(doc.guestId));
    if (doc?.email) set.add(String(doc.email));
    if (doc?.username) set.add(String(doc.username));
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

  const equivalents = await expandUserIdEquivalents(param);
  
  // Check payload identifiers against the equivalents set
  if (payload.id && equivalents.has(String(payload.id))) return true;
  if (payload.userId && equivalents.has(String(payload.userId))) return true;
  if (payload._id && equivalents.has(String(payload._id))) return true;
  if (payload.guestId && equivalents.has(String(payload.guestId))) return true;

  // Resolve payload email to further identifiers if needed
  try {
    if (payload.email) {
      if (equivalents.has(String(payload.email))) return true;
      const u = await User.findOne({ email: String(payload.email) }).select('_id guestId username').lean().catch(() => null);
      if (u) {
        if (u._id && equivalents.has(String(u._id))) return true;
        if (u.guestId && equivalents.has(String(u.guestId))) return true;
        if (u.username && equivalents.has(String(u.username))) return true;
      }
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

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ message: 'Unauthorized' });
  const ok = await authMatchesUserId(payload, userId);
  if (!ok) return res.status(403).json({ message: 'Forbidden' });

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

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ message: 'Unauthorized' });
  const ok = await authMatchesUserId(payload, userIdParam);
  if (!ok) return res.status(403).json({ message: 'Forbidden' });

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

  const incomingUsernameRaw = req.body?.username;
  const incomingUsername = typeof incomingUsernameRaw === 'string' ? incomingUsernameRaw.trim() : null;
  const currentUsername = existing?.username ? String(existing.username).trim() : '';
  const wantsUsernameChange = typeof incomingUsername === 'string' && incomingUsername.length > 0 && incomingUsername !== currentUsername;

  // Username/name is set only during /auth/signup or /auth/guest.
  // Disallow any attempt to change it via Settings/Profile updates.
  if (wantsNameChange || wantsUsernameChange) {
    return res.status(403).json({ message: 'Username cannot be changed from Settings.' });
  }

  // Whitelist only profile/settings fields and drop sensitive fields.
  const safeBody = buildSafeUserPatch(req.body, existing);

  // Disallow profane content in profile fields like `bio`, `username`, `displayName`.
  try {
    if (typeof safeBody.bio === 'string' && containsProfanity(safeBody.bio, { lenient: true })) {
      return res.status(400).json({ message: 'Profile bio contains disallowed content' });
    }
    if (typeof incomingUsername === 'string' && incomingUsername && containsProfanity(incomingUsername, { lenient: true })) {
      return res.status(400).json({ message: 'Username contains disallowed content' });
    }
    if (typeof safeBody.displayName === 'string' && containsProfanity(safeBody.displayName, { lenient: true })) {
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

  const meId = String(me._id);
  const existing = Array.isArray(me.blockedUsers) ? me.blockedUsers.map(String).filter(Boolean) : [];
  const next = existing.includes(canonTarget) ? existing : [...existing, canonTarget];

  try {
    // 1. Update blocked list
    const updated = await User.findByIdAndUpdate(meId, { $set: { blockedUsers: next } }, { new: true }).lean().exec();
    syncUserStoreEntry(updated);

    // 2. Remove from friends/followers/following on both sides
    const targetEquivalents = Array.from(await expandUserIdEquivalents(blockedUserId));
    const myEquivalents = Array.from(await expandUserIdEquivalents(meId));

    // Remove target from my lists
    await User.updateOne(
      { _id: meId },
      { 
        $pull: { 
          friends: { $in: targetEquivalents },
          following: { $in: targetEquivalents },
          followers: { $in: targetEquivalents }
        } 
      }
    ).exec();

    // Remove me from target lists
    await User.updateMany(
      { $or: [{ _id: blockedUserId }, { guestId: blockedUserId }] },
      { 
        $pull: { 
          friends: { $in: myEquivalents },
          following: { $in: myEquivalents },
          followers: { $in: myEquivalents }
        } 
      }
    ).exec();

    return res.json({ message: 'blocked', target: canonTarget, blockedUsers: next });
  } catch (e) {
    return res.status(500).json({ message: 'Failed to persist block', error: e?.message || e });
  }
}));

router.post('/:id/follow', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const targetIdRaw = req.body?.targetId || req.body?.userId;
  if (!targetIdRaw) return res.status(400).json({ message: 'targetId required' });

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ message: 'Unauthorized' });
  const ok = await authMatchesUserId(payload, userId);
  if (!ok) return res.status(403).json({ message: 'Forbidden' });

  const me = await getAuthedUserDoc(payload, userId);
  if (!me) return res.status(404).json({ message: 'User not found' });

  const meId = String(me._id);
  const targetId = await canonicalBlockedId(targetIdRaw);
  if (!targetId) return res.status(400).json({ message: 'Invalid targetId' });
  if (String(targetId) === String(meId)) return res.status(400).json({ message: 'Cannot follow yourself' });

  // Check if blocked
  if (Array.isArray(me.blockedUsers) && me.blockedUsers.includes(targetId)) {
    return res.status(403).json({ message: 'Unblock user to follow them' });
  }

  try {
    // Add to my following
    const updatedMe = await User.findByIdAndUpdate(meId, { $addToSet: { following: targetId } }, { new: true }).lean().exec();
    syncUserStoreEntry(updatedMe);

    // Add to target's followers
    const targetDoc = await User.findOneAndUpdate(
      { $or: [{ _id: targetId }, { guestId: targetId }] },
      { $addToSet: { followers: meId } },
      { new: true }
    ).lean().exec();
    if (targetDoc) syncUserStoreEntry(targetDoc);

    res.json({ message: 'followed', targetId, following: updatedMe.following });
  } catch (e) {
    res.status(500).json({ message: 'Failed to follow user', error: e?.message || e });
  }
}));

router.post('/:id/unfollow', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const targetIdRaw = req.body?.targetId || req.body?.userId;
  if (!targetIdRaw) return res.status(400).json({ message: 'targetId required' });

  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ message: 'Unauthorized' });
  const ok = await authMatchesUserId(payload, userId);
  if (!ok) return res.status(403).json({ message: 'Forbidden' });

  const me = await getAuthedUserDoc(payload, userId);
  if (!me) return res.status(404).json({ message: 'User not found' });

  const meId = String(me._id);
  const targetId = await canonicalBlockedId(targetIdRaw);

  try {
    // Remove from my following
    const updatedMe = await User.findByIdAndUpdate(meId, { $pull: { following: targetId } }, { new: true }).lean().exec();
    syncUserStoreEntry(updatedMe);

    // Remove from target's followers
    const targetDoc = await User.findOneAndUpdate(
      { $or: [{ _id: targetId }, { guestId: targetId }] },
      { $pull: { followers: meId } },
      { new: true }
    ).lean().exec();
    if (targetDoc) syncUserStoreEntry(targetDoc);

    res.json({ message: 'unfollowed', targetId, following: updatedMe.following });
  } catch (e) {
    res.status(500).json({ message: 'Failed to unfollow user', error: e?.message || e });
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
