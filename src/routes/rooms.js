import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import Room from '../models/Room.js';
import { users } from '../lib/userStore.js';
import User from '../models/User.js';
import requireVerifiedForHighRisk from '../middleware/riskGuard.js';

const router = Router();
const rooms = new Map();
// Simple in-memory waiting queue for random chat pairing
const waitingQueue = [];

router.get('/', asyncHandler(async (req, res) => {
  // prefer DB-backed list but fall back to in-memory
  try {
    const { type } = req.query || {};
    const match = {};
    if (type) match.type = String(type);

    // Use aggregation to compute member count and sort by it (desc)
    const pipeline = [
      { $match: match },
      { $addFields: { memberCount: { $size: { $ifNull: ["$members", []] } } } },
      { $sort: { memberCount: -1, updatedAt: -1 } }
    ];
    const docs = await Room.aggregate(pipeline).allowDiskUse(true).exec();
    const mapped = docs.map(d => ({ id: d._id, ...d }));
    res.json(mapped);
    return;
  } catch (e) {
    res.json(Array.from(rooms.values()));
  }
}));

router.post('/', asyncHandler(async (req, res) => {
  // Require authenticated registered user to create a room
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (e) {
    return res.status(401).json({ message: 'Invalid token' });
  }

  if (!payload || payload.userType !== 'registered') {
    return res.status(403).json({ message: 'Only registered users can create rooms' });
  }

  // Require email-verified for room creation
  let userRecord = null;
  if (payload.email && users.has(payload.email)) userRecord = users.get(payload.email);
  if (!userRecord && payload.id) userRecord = users.get(payload.id) || null;
  if (!userRecord) {
    // fallback to DB lookup
    try { userRecord = await User.findById(payload.id).lean().exec(); } catch (e) {}
  }
  const emailVerified = Boolean(userRecord && (userRecord.emailVerified || userRecord.emailVerified === true));
  if (!emailVerified) {
    return res.status(403).json({ message: 'Only email-verified registered users can create rooms' });
  }

  const id = `room-${Date.now()}`;
  const ownerId = payload.id;
  const room = {
    id,
    ...req.body,
    owner: ownerId,
    createdBy: ownerId,
    participants: Array.from(new Set([ownerId, ...(req.body.participants || [])]))
  };
  // persist to DB
  try {
    const doc = new Room({ _id: id, name: room.name || '', description: room.description || '', type: room.type || 'public', owner: ownerId, createdBy: ownerId, participants: room.participants, members: room.members || room.participants, settings: room.settings || {}, category: room.category || '' });
    await doc.save();
  } catch (e) {
    // ignore persistence errors but keep in-memory
    console.warn('Could not persist room to DB', e?.message || e);
  }
  rooms.set(id, room);
  res.json(room);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  // try DB first
  try {
    const doc = await Room.findById(id).lean();
    if (doc) return res.json({ id: doc._id, ...doc });
  } catch (e) {}
  const room = rooms.get(id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  res.json(room);
}));

router.post('/:id/join', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const userId = req.body.userId;
  const room = rooms.get(id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  room.participants = [...new Set([...(room.participants || []), userId])];
  rooms.set(id, room);
  try {
    // update DB if room exists there
    await Room.findByIdAndUpdate(id, { $addToSet: { participants: userId, members: userId }, $set: { updatedAt: new Date() } }, { upsert: false });
    // fetch fresh DB doc to avoid returning stale/in-memory-only values
    const fresh = await Room.findById(id).lean();
    if (fresh) return res.json({ id: fresh._id, ...fresh });
  } catch (e) {
    // ignore DB errors but continue to return in-memory room
    console.warn('Failed to update DB for join:', e?.message || e);
  }

  res.json(room);
}));

// Allow room creator/owner to delete a room (permanent removal)
router.delete('/:id', asyncHandler(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (e) {
    return res.status(401).json({ message: 'Invalid token' });
  }

  const id = req.params.id;
  // verify room exists
  let roomDoc = null;
  try { roomDoc = await Room.findById(id).lean(); } catch (e) {}
  if (!roomDoc) {
    // also check in-memory
    if (!rooms.has(id)) return res.status(404).json({ message: 'Room not found' });
  }

  // only creator/owner can delete
  const requesterId = payload.id;
  const ownerId = roomDoc ? (roomDoc.createdBy || roomDoc.owner) : null;
  if (ownerId && ownerId !== requesterId) return res.status(403).json({ message: 'Only room owner can delete this room' });

  try {
    if (roomDoc) await Room.deleteOne({ _id: id });
  } catch (e) {
    console.warn('Failed to delete room from DB', e?.message || e);
  }
  // remove from in-memory map as well
  rooms.delete(id);
  res.json({ message: 'Room deleted' });
}));

router.post('/:id/leave', asyncHandler(async (req, res) => {
  const id = req.params.id;
  const userId = req.body.userId;
  const room = rooms.get(id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  room.participants = (room.participants || []).filter(pid => pid !== userId);
  rooms.set(id, room);
  try { await Room.findByIdAndUpdate(id, { $pull: { participants: userId } }); } catch (e) {}
  res.json(room);
}));

// Update room settings / metadata
router.patch('/:id', asyncHandler(async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });

  let payload;
  try { payload = jwt.verify(token, env.jwtSecret); } catch (e) { return res.status(401).json({ message: 'Invalid token' }); }

  const id = req.params.id;
  const updates = req.body || {};

  // Only allow certain fields to be updated
  const allowed = ['name', 'description', 'category', 'settings', 'admins', 'members', 'isActive'];
  const setObj = {};
  for (const k of Object.keys(updates)) {
    if (allowed.includes(k)) setObj[k] = updates[k];
  }

  try {
    const roomDoc = await Room.findById(id).lean();
    if (!roomDoc) return res.status(404).json({ message: 'Room not found' });

    const requesterId = payload.id;
    const ownerId = roomDoc.createdBy || roomDoc.owner;
    const isAdmin = Array.isArray(roomDoc.admins) && roomDoc.admins.includes(requesterId);
    if (ownerId && ownerId !== requesterId && !isAdmin) return res.status(403).json({ message: 'Only room owner or admins can update settings' });

    // merge settings if provided
    if (setObj.settings && roomDoc.settings) {
      setObj.settings = { ...(roomDoc.settings || {}), ...(setObj.settings || {}) };
    }

    setObj.updatedAt = new Date();
    const updated = await Room.findByIdAndUpdate(id, { $set: setObj }, { new: true }).lean();
    if (updated) return res.json({ id: updated._id, ...updated });
  } catch (e) {
    console.warn('Failed to update room', e?.message || e);
    return res.status(500).json({ message: 'Failed to update room' });
  }

  res.status(500).json({ message: 'Failed to update room' });
}));

router.post('/dm', requireVerifiedForHighRisk, asyncHandler(async (req, res) => {
  const id = `dm-${Date.now()}`;
  // Store DM rooms as private rooms with category 'dm' so they are not listed as public
  const room = { id, type: 'private', category: 'dm', participants: [req.body.userId1, req.body.userId2] };
  // persist
  try {
    const doc = new Room({ _id: id, name: `DM:${req.body.userId1}:${req.body.userId2}`, type: 'private', category: 'dm', participants: room.participants, members: room.participants, createdBy: req.body.userId1 });
    await doc.save();
  } catch (e) { console.warn('Could not persist DM room', e?.message || e); }
  rooms.set(id, room);
  res.json(room);
}));

router.post('/random', requireVerifiedForHighRisk, async (req, res) => {
  const userId = req.body.userId;
  if (!userId) return res.status(400).json({ message: 'userId required' });

  // Try to find a waiting user to pair with
  for (let i = 0; i < waitingQueue.length; i++) {
    const waiter = waitingQueue[i];
    if (waiter.userId !== userId) {
      // Remove matched waiter
      waitingQueue.splice(i, 1);
      const id = `dm-${Date.now()}`;
      // Store as a private room with category 'dm'
      const room = { id, type: 'private', category: 'dm', participants: [waiter.userId, userId] };
      // persist
      try {
        const doc = new Room({ _id: id, name: `DM:${waiter.userId}:${userId}`, type: 'private', category: 'dm', participants: room.participants, members: room.participants, createdBy: waiter.userId });
        await doc.save();
      } catch (e) { console.warn('Could not persist random DM room', e?.message || e); }
      rooms.set(id, room);
      // resolve the waiting promise if present
      try {
        if (waiter.resolve) waiter.resolve(room);
      } catch (e) {}
      return res.json(room);
    }
  }

  // No match found, add to waiting queue and wait for up to 20s
  let resolver;
  const waitPromise = new Promise((resolve) => { resolver = resolve; });
  const entry = { userId, resolve: resolver, createdAt: Date.now() };
  waitingQueue.push(entry);

  // timeout to remove from queue
  const timeout = setTimeout(() => {
    const idx = waitingQueue.indexOf(entry);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    try { resolver(null); } catch (e) {}
  }, 20000);

  try {
    const matchedRoom = await waitPromise;
    clearTimeout(timeout);
    if (matchedRoom) {
      return res.json(matchedRoom);
    }
    // timed out, return waiting status
    return res.status(202).json({ status: 'waiting' });
  } catch (err) {
    clearTimeout(timeout);
    return res.status(500).json({ message: 'failed to join random queue' });
  }
});

export default router;
