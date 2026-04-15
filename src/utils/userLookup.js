import mongoose from 'mongoose';
import User from '../models/User.js';

/**
 * Safely finds a user by identifier, supporting both MongoDB ObjectIds 
 * and custom string/numeric IDs (like those used for guests).
 * Also falls back to email and username check if no ID match is found.
 * 
 * @param {string|number} identifier - The user identifier to search for (ID, guestId, email, or username)
 * @param {string} select - Mongoose select string (e.g., 'email displayName')
 * @returns {Promise<Object|null>} - The lean user document or null
 */
export const findUserSafely = async (identifier, select = '') => {
  if (!identifier) return null;
  const id = String(identifier).trim();
  
  const or = [
    { guestId: id },
    { email: id },
    { username: id }
  ];

  // Only attempts _id lookup if it's a valid ObjectId to avoid cast errors
  if (mongoose.Types.ObjectId.isValid(id)) {
    or.unshift({ _id: id });
  }

  try {
    let q = User.findOne({ $or: or });
    if (select) q = q.select(select);
    return await q.lean().exec();
  } catch (e) {
    // Gracefully handle any unexpected DB issues
    return null;
  }
};
