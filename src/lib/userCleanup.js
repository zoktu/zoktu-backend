import User from '../models/User.js';
import { env } from '../config/env.js';

/**
 * Automatically deletes accounts that have been inactive for a specified number of months.
 * Protects Admins, Superadmins, and Premium users.
 */
export const cleanupInactiveUsers = async () => {
  const monthsThreshold = Number(env.inactiveUserDeleteMonths || 6);
  if (isNaN(monthsThreshold) || monthsThreshold <= 0) return;

  const thresholdDate = new Date();
  thresholdDate.setMonth(thresholdDate.getMonth() - monthsThreshold);

  console.log(`[User-Cleanup] Starting scan for users inactive since ${thresholdDate.toISOString()} (${monthsThreshold} months)...`);

  try {
    const filter = {
      $or: [
        { lastSeen: { $lt: thresholdDate } },
        { $and: [{ lastSeen: { $exists: false } }, { createdAt: { $lt: thresholdDate } }] }
      ],
      role: { $nin: ['admin', 'superadmin'] },
      isPremium: { $ne: true }
    };

    const countBefore = await User.countDocuments(filter);
    if (countBefore === 0) {
      console.log('[User-Cleanup] No inactive accounts found.');
      return;
    }

    const result = await User.deleteMany(filter);
    console.log(`[User-Cleanup] Success! Permanently deleted ${result.deletedCount} inactive accounts.`);
  } catch (error) {
    console.error('[User-Cleanup] Error during inactive user deletion:', error);
  }
};

/**
 * Schedules the cleanup job to run every 24 hours.
 */
export const startUserCleanupJob = () => {
    // Run once on startup
    setTimeout(cleanupInactiveUsers, 5000); 

    // Schedule every 24 hours
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    setInterval(cleanupInactiveUsers, TWENTY_FOUR_HOURS);
    
    console.log('[User-Cleanup] Scheduled daily inactive user cleanup task.');
};
