import { Router } from 'express';

const router = Router();

// In-memory placeholder
const friendRequests = new Map();

router.get('/requests', (req, res) => {
  const { userId } = req.query;
  const requests = friendRequests.get(userId) || [];
  res.json(requests);
});

router.post('/requests', (req, res) => {
  const { fromUserId, toUserId } = req.body;
  if (!fromUserId || !toUserId) return res.status(400).json({ message: 'fromUserId and toUserId are required' });
  const list = friendRequests.get(toUserId) || [];
  list.push({ id: `req-${Date.now()}`, fromUserId, toUserId, status: 'pending' });
  friendRequests.set(toUserId, list);
  res.json({ message: 'request sent' });
});

router.post('/requests/:id/accept', (req, res) => {
  res.json({ message: 'request accepted', id: req.params.id });
});

router.post('/requests/:id/reject', (req, res) => {
  res.json({ message: 'request rejected', id: req.params.id });
});

export default router;
