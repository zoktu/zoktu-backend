import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
const rooms = new Map();

router.get('/', (_req, res) => {
  res.json(Array.from(rooms.values()));
});

router.post('/', asyncHandler(async (req, res) => {
  const id = `room-${Date.now()}`;
  const room = { id, ...req.body, participants: req.body.participants || [] };
  rooms.set(id, room);
  res.json(room);
}));

router.get('/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  res.json(room);
});

router.post('/:id/join', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  room.participants = [...new Set([...(room.participants || []), req.body.userId])];
  rooms.set(req.params.id, room);
  res.json(room);
});

router.post('/:id/leave', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ message: 'Room not found' });
  room.participants = (room.participants || []).filter(id => id !== req.body.userId);
  rooms.set(req.params.id, room);
  res.json(room);
});

router.post('/dm', (req, res) => {
  const id = `dm-${Date.now()}`;
  const room = { id, type: 'dm', participants: [req.body.userId1, req.body.userId2] };
  rooms.set(id, room);
  res.json(room);
});

router.post('/random', (req, res) => {
  const id = `random-${Date.now()}`;
  const room = { id, type: 'public', participants: [req.body.userId], settings: req.body.preferences || {} };
  rooms.set(id, room);
  res.json(room);
});

export default router;
