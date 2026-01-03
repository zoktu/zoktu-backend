import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

// Placeholder memory store
const users = new Map();

router.get('/', (req, res) => {
  // Support ?online=true filter; return all known users for now.
  const list = Array.from(users.values());
  res.json(list);
});

router.get('/:id', (req, res) => {
  let user = users.get(req.params.id) || null;
  if (!user) {
    // create a minimal placeholder so guest users resolve
    user = { id: req.params.id, displayName: 'Guest', userType: 'guest' };
    users.set(req.params.id, user);
  }
  res.json(user);
});

router.patch('/:id', asyncHandler(async (req, res) => {
  const existing = users.get(req.params.id) || { id: req.params.id };
  const updated = { ...existing, ...req.body };
  users.set(req.params.id, updated);
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
