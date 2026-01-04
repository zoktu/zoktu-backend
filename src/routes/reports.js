import { Router } from 'express';

const router = Router();

// Simple in-memory reports store (persist later if needed)
const reports = [];

router.post('/', (req, res) => {
  const { reporterId, targetId, reason } = req.body || {};
  if (!reporterId || !targetId) return res.status(400).json({ message: 'reporterId and targetId required' });
  const id = `report-${Date.now()}`;
  const entry = { id, reporterId, targetId, reason: reason || 'unspecified', createdAt: Date.now() };
  reports.push(entry);
  console.log('📣 New report received', entry);
  res.json({ message: 'Report submitted', id });
});

export default router;
