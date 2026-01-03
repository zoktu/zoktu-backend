import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
const messages = new Map();

router.get('/rooms/:roomId/messages', (req, res) => {
  const list = messages.get(req.params.roomId) || [];
  res.json(list.slice(-(Number(req.query.limit) || 50)));
});

router.post('/rooms/:roomId/messages', asyncHandler(async (req, res) => {
  const roomId = req.params.roomId;
  const list = messages.get(roomId) || [];
  const msg = { id: `msg-${Date.now()}`, roomId, ...req.body, timestamp: new Date().toISOString() };
  list.push(msg);
  messages.set(roomId, list);
  res.json(msg);
}));

router.patch('/messages/:id', (req, res) => {
  const updated = { id: req.params.id, ...req.body, isEdited: true, editedAt: new Date().toISOString() };
  res.json(updated);
});

router.delete('/messages/:id', (req, res) => {
  res.json({ message: 'deleted', id: req.params.id });
});

router.post('/messages/:id/reactions', (req, res) => {
  res.json({ message: 'reaction added', emoji: req.body.emoji, userId: req.body.userId });
});

router.delete('/messages/:id/reactions', (req, res) => {
  res.json({ message: 'reaction removed', emoji: req.body?.emoji, userId: req.body?.userId });
});

export default router;
