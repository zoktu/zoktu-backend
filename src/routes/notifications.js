import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';

const router = Router();

const looksLikeObjectId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));

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

const getAuthIdentity = async (req) => {
  const payload = getAuthPayload(req);
  if (!payload) return null;

  const ids = new Set();
  const add = (v) => {
    if (v === undefined || v === null) return;
    const s = String(v).trim();
    if (!s) return;
    ids.add(s);
  };

  add(payload.id);
  add(payload.userId);
  add(payload._id);
  add(payload.guestId);
  if (payload.email) add(String(payload.email).toLowerCase());

  try {
    const email = payload.email ? String(payload.email).toLowerCase() : null;
    if (email) {
      const u = await User.findOne({ email }).lean().catch(() => null);
      if (u) {
        add(u._id);
        add(u.guestId);
        if (u.email) add(String(u.email).toLowerCase());
      }
    }
  } catch (e) {}

  try {
    if (payload.id) {
      const u = await User.findOne({ $or: [{ _id: String(payload.id) }, { guestId: String(payload.id) }] })
        .lean()
        .catch(() => null);
      if (u) {
        add(u._id);
        add(u.guestId);
        if (u.email) add(String(u.email).toLowerCase());
      }
    }
  } catch (e) {}

  const primary = (
    (payload.id ? String(payload.id) : null) ||
    (payload._id ? String(payload._id) : null) ||
    (payload.userId ? String(payload.userId) : null) ||
    (payload.guestId ? String(payload.guestId) : null) ||
    (payload.email ? String(payload.email).toLowerCase() : null)
  );

  return { payload, ids: Array.from(ids), primary };
};

router.get('/', asyncHandler(async (req, res) => {
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = req.query.before;

  const query = { userId: { $in: auth.ids } };
  if (before) {
    let beforeDate = null;
    const parsed = new Date(String(before));
    if (!Number.isNaN(parsed.getTime())) beforeDate = parsed;

    if (!beforeDate && looksLikeObjectId(before)) {
      const ref = await Notification.findById(String(before)).select('createdAt').lean().catch(() => null);
      if (ref?.createdAt) beforeDate = new Date(ref.createdAt);
    }

    if (beforeDate) query.createdAt = { $lt: beforeDate };
  }

  const docs = await Notification.find(query).sort({ createdAt: -1 }).limit(limit).lean();

  const mapped = (docs || []).map((d) => ({
    id: String(d._id),
    userId: d.userId,
    actorId: d.actorId,
    roomId: d.roomId,
    messageId: d.messageId,
    type: d.type,
    title: d.title,
    message: d.message,
    read: Boolean(d.read),
    createdAt: d.createdAt
  }));

  res.json(mapped);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ message: 'id required' });

  const doc = await Notification.findOne({ _id: id, userId: { $in: auth.ids } }).exec().catch(() => null);
  if (!doc) return res.status(404).json({ message: 'Notification not found' });

  if (typeof req.body?.read === 'boolean') {
    doc.read = req.body.read;
  }

  await doc.save();
  res.json({ message: 'ok', id: String(doc._id), read: Boolean(doc.read) });
}));

router.post('/mark-all-read', asyncHandler(async (req, res) => {
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const result = await Notification.updateMany(
    { userId: { $in: auth.ids }, read: { $ne: true } },
    { $set: { read: true } }
  ).exec();

  res.json({ message: 'ok', updated: result?.modifiedCount ?? result?.nModified ?? 0 });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const auth = await getAuthIdentity(req);
  if (!auth?.primary) return res.status(401).json({ message: 'Unauthorized' });

  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ message: 'id required' });

  const result = await Notification.deleteOne({ _id: id, userId: { $in: auth.ids } }).exec();
  if (!result?.deletedCount) return res.status(404).json({ message: 'Notification not found' });

  res.json({ message: 'deleted', id });
}));

export default router;
