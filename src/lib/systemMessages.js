import { getModelForRoom } from '../models/Message.js';
import { getRoomDocByIdWithCache as getRoomDocById } from './roomCache.js';

/**
 * Sends and persists a system message to a room or DM.
 * @param {object} io - Socket.io instance
 * @param {string} roomId - ID of the room or DM
 * @param {string} content - Message content
 * @param {object} meta - Optional metadata
 */
export async function sendSystemMessage(io, roomId, content, meta = {}) {
  const rid = String(roomId || '').trim();
  if (!rid || !content) return null;

  try {
    const roomDoc = await getRoomDocById(rid);
    const Model = getModelForRoom(roomDoc);
    
    const systemMsg = new Model({
      roomId: rid,
      senderId: 'system',
      senderName: 'System',
      content: content,
      type: 'system',
      meta: meta,
      createdAt: new Date()
    });

    await systemMsg.save();

    const payload = {
      id: systemMsg._id.toString(),
      roomId: rid,
      senderId: 'system',
      senderName: 'System',
      content: content,
      type: 'system',
      timestamp: systemMsg.createdAt.toISOString(),
      meta
    };

    if (io) {
      io.to(rid).emit('room:message', payload);
    }

    return systemMsg;
  } catch (err) {
    console.error(`[SystemMessage] Failed to send to ${rid}:`, err);
    return null;
  }
}
