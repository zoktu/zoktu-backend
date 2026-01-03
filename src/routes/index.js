import { Router } from 'express';
import authRoutes from './auth.js';
import usersRoutes from './users.js';
import roomsRoutes from './rooms.js';
import messagesRoutes from './messages.js';
import encryptedRoutes from './encrypted.js';
import healthRoutes from './health.js';
import friendsRoutes from './friends.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/rooms', roomsRoutes);
router.use('/', messagesRoutes);
router.use('/', encryptedRoutes);
router.use('/health', healthRoutes);
router.use('/friends', friendsRoutes);

export default router;
