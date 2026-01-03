import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
const encryptedMessages = new Map();
const encryptedRooms = new Map();

router.get('/encrypted/messages', (req, res) => {
  const roomId = req.query.roomId;
  const list = roomId ? (encryptedMessages.get(roomId) || []) : [];
  res.json(list);
});

router.post('/encrypted/messages', asyncHandler(async (req, res) => {
  const roomId = req.body.roomId;
  const list = encryptedMessages.get(roomId) || [];
  const msg = { id: `enc-${Date.now()}`, ...req.body, timestamp: new Date().toISOString() };
  list.push(msg);
  encryptedMessages.set(roomId, list);
  res.json(msg);
}));

router.patch('/encrypted/messages/:id', (req, res) => {
  res.json({ id: req.params.id, ...req.body, isEdited: true });
});

router.post('/encrypted/messages/:id/reactions', (req, res) => {
  res.json({ message: 'reaction added', userId: req.body.userId, emoji: req.body.emoji });
});

router.delete('/encrypted/messages/:id/reactions', (req, res) => {
  res.json({ message: 'reaction removed', userId: req.body?.userId });
});

router.post('/encrypted/rooms', (req, res) => {
  const id = `enc-room-${Date.now()}`;
  const roomKey = req.body.roomKey || 'placeholder-key';
  encryptedRooms.set(id, { id, ...req.body, roomKey });
  res.json({ id, roomKey });
});

router.post('/encrypted/rooms/:id/join', (req, res) => {
  const room = encryptedRooms.get(req.params.id);
  if (!room) return res.status(404).json({ message: 'Encrypted room not found' });
  res.json({ roomKey: room.roomKey || 'placeholder-key' });
});

export default router;
