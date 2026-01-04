import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { users, persistUserToDb } from '../lib/userStore.js';

const router = Router();

// Return all users known in-memory (seeded from DB at startup)
router.get('/', (req, res) => {
  const list = Array.from(users.values());
  res.json(list);
});

// Get user by id (uses in-memory map seeded from DB)
router.get('/:id', (req, res) => {
  let user = users.get(req.params.id) || null;
  if (!user) {
    user = { id: req.params.id, displayName: 'Guest', userType: 'guest' };
    users.set(req.params.id, user);
  }
  res.json(user);
});

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
  const existing = users.get(req.params.id) || { id: req.params.id };
  const updated = { ...existing, ...req.body };
  // update in-memory store
  users.set(req.params.id, updated);
  // attempt to persist to DB (non-fatal)
  try {
    const saved = await persistUserToDb(updated);
    if (saved) {
      // saved is a lean Mongo doc - update in-memory store with canonical data
      const entry = { ...saved, id: String(saved.guestId || saved._id) };
      users.set(req.params.id, entry);
      return res.json(saved);
    }
  } catch (e) {
    console.warn('Could not persist user update to DB', e?.message || e);
    return res.status(500).json({ message: 'Failed to persist user update', error: e?.message || e });
  }

  // If nothing was saved, respond with the updated in-memory record
  res.json(updated);
}));

router.post('/:id/block', (req, res) => {
  res.json({ message: 'blocked', target: req.body.blockedUserId });
});

router.post('/:id/unblock', (req, res) => {
  res.json({ message: 'unblocked', target: req.body.unblockedUserId });
});

router.post('/:id/friends/remove', (req, res) => {
  res.json({ message: 'friend removed', target: req.body.friendId });
});

export default router;
