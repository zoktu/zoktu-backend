import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import User from '../models/User.js';
import FriendRequest from '../models/FriendRequest.js';
import { upsertUserInMemory } from '../lib/userStore.js';

const router = Router();

const uniqStrings = (arr) => Array.from(new Set((arr || []).filter(Boolean).map((v) => String(v))));

const expandUserIdentifiers = async ({ id, email }) => {
  const ids = new Set();
  if (id) ids.add(String(id));

  try {
    if (email) {
      const uByEmail = await User.findOne({ email: String(email) }).select('_id guestId userType').lean().catch(() => null);
      if (uByEmail?._id) ids.add(String(uByEmail._id));
      if (uByEmail?.guestId) ids.add(String(uByEmail.guestId));
    }
  } catch (e) {}

  try {
    if (id) {
      const u = await User.findOne({ $or: [{ _id: String(id) }, { guestId: String(id) }] }).select('_id guestId userType').lean().catch(() => null);
      if (u?._id) ids.add(String(u._id));
      if (u?.guestId) ids.add(String(u.guestId));
    }
  } catch (e) {}

  return Array.from(ids);
};

const canonicalIdForAuthPayload = async (payload) => {
  if (!payload) return null;
  try {
    if (payload.email) {
      const u = await User.findOne({ email: String(payload.email) }).select('_id guestId userType').lean().catch(() => null);
      if (u) {
        if (u.userType === 'guest' && u.guestId) return String(u.guestId);
        if (u._id) return String(u._id);
      }
    }
  } catch (e) {}
  return payload.id ? String(payload.id) : null;
};

const canonicalIdForUserId = async (id) => {
  if (!id) return null;
  try {
    const u = await User.findOne({ $or: [{ _id: String(id) }, { guestId: String(id) }] }).select('_id guestId userType').lean().catch(() => null);
    if (!u) return String(id);
    if (u.userType === 'guest' && u.guestId) return String(u.guestId);
    if (u._id) return String(u._id);
    return String(id);
  } catch (e) {
    return String(id);
  }
};

const canonicalFriendKeyForUserDoc = (doc, fallbackId) => {
  if (doc && doc.userType === 'guest' && doc.guestId) return String(doc.guestId);
  if (doc && doc._id) return String(doc._id);
  return fallbackId ? String(fallbackId) : null;
};

// List pending friend requests for the authenticated user
router.get('/requests', requireAuth, asyncHandler(async (req, res) => {
  const payload = req.user;
  const expanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const canonical = (await canonicalIdForAuthPayload(payload)) || expanded[0] || null;
  const allowIds = uniqStrings([canonical, ...(expanded || [])]);

  const toIds = allowIds;
  const docs = await FriendRequest.find({ toUserId: { $in: toIds }, status: 'pending' })
    .sort({ createdAt: -1 })
    .lean()
    .exec();

  res.json((docs || []).map((d) => ({
    id: String(d._id),
    fromUserId: String(d.fromUserId),
    toUserId: String(d.toUserId),
    status: d.status,
    message: d.message,
    createdAt: d.createdAt
  })));
}));

// Send a friend request (payload sender is taken from auth; accepts multiple body key names)
router.post('/requests', requireAuth, asyncHandler(async (req, res) => {
  const payload = req.user;
  const fromId = (await canonicalIdForAuthPayload(payload)) || (payload?.id ? String(payload.id) : null);
  if (!fromId) return res.status(401).json({ message: 'Unauthorized' });

  const body = req.body || {};
  const rawToId = body.receiverId || body.toUserId || body.targetUserId || null;
  const message = body.message ? String(body.message) : undefined;
  if (!rawToId) return res.status(400).json({ message: 'receiverId (or toUserId) is required' });
  const toId = await canonicalIdForUserId(rawToId);
  if (!toId) return res.status(400).json({ message: 'Invalid receiverId' });
  if (String(toId) === String(fromId)) return res.status(400).json({ message: 'Cannot send friend request to yourself' });

  // If already friends, no-op
  try {
    const me = await User.findOne({ $or: [{ _id: String(fromId) }, { guestId: String(fromId) }] }).select('_id guestId friends').lean().catch(() => null);
    const myFriends = Array.isArray(me?.friends) ? me.friends.map(String) : [];
    if (myFriends.includes(String(toId))) {
      return res.json({ message: 'already friends' });
    }
  } catch (e) {}

  // Idempotent: one pending request per pair
  const existing = await FriendRequest.findOne({ fromUserId: String(fromId), toUserId: String(toId), status: 'pending' }).lean().catch(() => null);
  if (existing?._id) {
    return res.json({ id: String(existing._id), message: 'request already pending' });
  }

  const doc = new FriendRequest({ fromUserId: String(fromId), toUserId: String(toId), status: 'pending', ...(message ? { message } : {}) });
  await doc.save();
  res.json({ id: String(doc._id), fromUserId: doc.fromUserId, toUserId: doc.toUserId, status: doc.status });
}));

const acceptRequest = async (req, res) => {
  const payload = req.user;
  const expanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const canonical = (await canonicalIdForAuthPayload(payload)) || expanded[0] || null;
  const allowIds = uniqStrings([canonical, ...(expanded || [])]);
  if (allowIds.length === 0) return res.status(401).json({ message: 'Unauthorized' });

  const requestId = String(req.params.id || '');
  const fr = await FriendRequest.findById(requestId).lean().catch(() => null);
  if (!fr) return res.status(404).json({ message: 'Request not found' });
  if (!allowIds.includes(String(fr.toUserId))) return res.status(403).json({ message: 'Forbidden' });

  await FriendRequest.findByIdAndUpdate(requestId, { $set: { status: 'accepted' } }).catch(() => {});

  // Add each other as friends (store canonical keys so lookups work across uid/_id/guestId)
  const fromLookupId = String(fr.fromUserId);
  const toLookupId = String(fr.toUserId);

  const fromDoc = await User.findOne({ $or: [{ _id: fromLookupId }, { guestId: fromLookupId }] }).lean().catch(() => null);
  const toDoc = await User.findOne({ $or: [{ _id: toLookupId }, { guestId: toLookupId }] }).lean().catch(() => null);

  const fromKey = canonicalFriendKeyForUserDoc(fromDoc, fromLookupId);
  const toKey = canonicalFriendKeyForUserDoc(toDoc, toLookupId);

  try {
    await User.updateOne(
      { $or: [{ _id: fromLookupId }, { guestId: fromLookupId }] },
      { $addToSet: { friends: String(toKey) } }
    ).exec();
  } catch (e) {}
  try {
    await User.updateOne(
      { $or: [{ _id: toLookupId }, { guestId: toLookupId }] },
      { $addToSet: { friends: String(fromKey) } }
    ).exec();
  } catch (e) {}

  // Sync in-memory store so /users/:id returns updated friends immediately
  try {
    const updatedFrom = await User.findOne({ $or: [{ _id: fromLookupId }, { guestId: fromLookupId }] }).lean().catch(() => null);
    if (updatedFrom) upsertUserInMemory({ ...updatedFrom, id: String(updatedFrom._id) });
  } catch (e) {}
  try {
    const updatedTo = await User.findOne({ $or: [{ _id: toLookupId }, { guestId: toLookupId }] }).lean().catch(() => null);
    if (updatedTo) upsertUserInMemory({ ...updatedTo, id: String(updatedTo._id) });
  } catch (e) {}

  res.json({ message: 'request accepted', id: requestId, fromUserId: fromKey, toUserId: toKey });
};

const declineRequest = async (req, res) => {
  const payload = req.user;
  const expanded = await expandUserIdentifiers({ id: payload?.id, email: payload?.email });
  const canonical = (await canonicalIdForAuthPayload(payload)) || expanded[0] || null;
  const allowIds = uniqStrings([canonical, ...(expanded || [])]);
  if (allowIds.length === 0) return res.status(401).json({ message: 'Unauthorized' });

  const requestId = String(req.params.id || '');
  const fr = await FriendRequest.findById(requestId).lean().catch(() => null);
  if (!fr) return res.status(404).json({ message: 'Request not found' });
  if (!allowIds.includes(String(fr.toUserId))) return res.status(403).json({ message: 'Forbidden' });

  await FriendRequest.findByIdAndUpdate(requestId, { $set: { status: 'declined' } }).catch(() => {});
  res.json({ message: 'request declined', id: requestId });
};

router.post('/requests/:id/accept', requireAuth, asyncHandler(acceptRequest));
router.post('/requests/:id/decline', requireAuth, asyncHandler(declineRequest));
// Backwards-compat alias
router.post('/requests/:id/reject', requireAuth, asyncHandler(declineRequest));

export default router;
