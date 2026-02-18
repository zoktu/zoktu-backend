import { Router } from 'express';
import authRoutes from './auth.js';
import usersRoutes from './users.js';
import roomsRoutes from './rooms.js';
import sitemapRoutes from './sitemap.js';
import messagesRoutes from './messages.js';
import encryptedRoutes from './encrypted.js';
import healthRoutes from './health.js';
import friendsRoutes from './friends.js';
import debugRoutes from './debug.js';
import uploadsRoutes from './uploads.js';
import reportsRoutes from './reports.js';
import sessionsRoutes from './sessions.js';
import notificationsRoutes from './notifications.js';
import paymentsRoutes from './payments.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/rooms', roomsRoutes);
router.use('/', sitemapRoutes);
router.use('/', messagesRoutes);
router.use('/', encryptedRoutes);
router.use('/health', healthRoutes);
router.use('/friends', friendsRoutes);
router.use('/debug', debugRoutes);
router.use('/uploads', uploadsRoutes);
router.use('/reports', reportsRoutes);
router.use('/sessions', sessionsRoutes);
router.use('/notifications', notificationsRoutes);
router.use('/payments', paymentsRoutes);

export default router;
