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
    const docs = await Model.find({ roomId: normalizedRoomId })
      .sort({ createdAt: -1 })
      .skip(retention)
      .limit(DEFAULT_PRUNE_BATCH_SIZE)
      .select('_id')
      .lean()
      .exec();

    const ids = (docs || []).map((doc) => doc?._id).filter(Boolean);
    if (!ids.length) return 0;

    const result = await Model.deleteMany({ _id: { $in: ids } }).exec();
    return Number(result?.deletedCount || result?.n || 0);
  } catch (e) {
    return 0;
  }
};
