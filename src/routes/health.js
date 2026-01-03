import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ status: 'ok', message: 'ChitZ backend is up' });
});

export default router;
