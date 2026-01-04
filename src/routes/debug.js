import { Router } from 'express';
import User from '../models/User.js';

const router = Router();

// Returns recent users from MongoDB for debugging
router.get('/recent-users', async (req, res) => {
  try {
    const docs = await User.find({}).sort({ createdAt: -1 }).limit(50).lean().exec();
    return res.json(docs.map(d => ({
      _id: d._id,
      guestId: d.guestId,
      email: d.email,
      displayName: d.displayName,
      userType: d.userType,
      createdAt: d.createdAt
    })));
  } catch (e) {
    console.error('debug/recent-users error:', e?.message || e);
    return res.status(500).json({ message: 'Failed to read users', error: e?.message || e });
  }
});

export default router;
