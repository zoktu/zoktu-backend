import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ status: 'ok', message: 'Zoktu backend is up' });
});

export default router;
