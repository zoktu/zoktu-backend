import { env } from '../config/env.js';

const parsePositiveInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const DEFAULT_RETENTION_LIMIT = parsePositiveInt(env.messageRetentionLimit, 50);
const DEFAULT_PRUNE_BATCH_SIZE = parsePositiveInt(env.messagePruneBatchSize, 500);
const DEFAULT_PRUNE_MIN_INTERVAL_MS = parsePositiveInt(env.messagePruneMinIntervalMs, 5000);

const lastPrunedAtByRoomKey = new Map();

const buildPruneKey = ({ Model, roomId }) => {
  const modelName = String(Model?.modelName || Model?.collection?.name || 'message').trim();
  return `${modelName}:${String(roomId || '').trim()}`;
};

export const pruneOldMessagesForRoom = async ({
  Model,
  roomId,
  keepLatest = DEFAULT_RETENTION_LIMIT,
  force = false
} = {}) => {
  const normalizedRoomId = String(roomId || '').trim();
  if (!Model || !normalizedRoomId) return 0;

  const pruneKey = buildPruneKey({ Model, roomId: normalizedRoomId });
  const now = Date.now();

  if (!force) {
    const lastAt = Number(lastPrunedAtByRoomKey.get(pruneKey) || 0);
    if (now - lastAt < DEFAULT_PRUNE_MIN_INTERVAL_MS) {
      return 0;
    }
  }
  lastPrunedAtByRoomKey.set(pruneKey, now);

  const retention = parsePositiveInt(keepLatest, DEFAULT_RETENTION_LIMIT);

  try {
    // Find the timestamp of the N-th (retention-th) most recent NON-SYSTEM message.
    // This message serves as our "cutoff" point for what history we want to keep.
    const cutoffDoc = await Model.findOne({ 
      roomId: normalizedRoomId, 
      type: { $ne: 'system' } 
    })
      .sort({ createdAt: -1, _id: -1 })
      .skip(retention - 1)
      .select('createdAt _id')
      .lean()
      .exec();

    // If we have fewer than 'retention' real messages, don't prune anything yet.
    if (!cutoffDoc) return 0;

    // Delete ALL messages (any type) that are older than our cutoff message.
    // This cleans up both old user messages and old system events.
    const result = await Model.deleteMany({
      roomId: normalizedRoomId,
      $or: [
        { createdAt: { $lt: cutoffDoc.createdAt } },
        { createdAt: cutoffDoc.createdAt, _id: { $lt: cutoffDoc._id } }
      ]
    }).exec();

    return Number(result?.deletedCount || result?.n || 0);
  } catch (e) {
    return 0;
  }
};
