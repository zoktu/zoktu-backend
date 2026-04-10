import { connectDb } from '../src/config/db.js';
import Room from '../src/models/Room.js';
import { env } from '../src/config/env.js';

function parseArgs() {
  const args = {};
  const raw = process.argv.slice(2);
  let pendingKey = null;

  for (const token of raw) {
    if (pendingKey) {
      if (token && !token.startsWith('--')) {
        args[pendingKey] = token;
        pendingKey = null;
        continue;
      }

      args[pendingKey] = true;
      pendingKey = token.startsWith('--') ? token.slice(2) : null;
      continue;
    }

    if (token.startsWith('--')) {
      pendingKey = token.slice(2);
    }
  }

  if (pendingKey) { 
    args[pendingKey] = true;
  }

  return args;
}

const args = parseArgs();
const name = args.name || 'New Group';
const id = args.id || `room-${Date.now()}`;
const owner = args.owner || args.createdBy || 'system';
const type = args.type || 'public';
const category = args.category || 'general';
const mongoUri = process.env.MONGO_URI || env.mongoUri;

console.log('Using MONGO_URI:', mongoUri ? '[configured]' : '[missing]');
try {
  await connectDb();
} catch (e) {
  console.error('DB connect failed', e?.message || e);
  process.exit(1);
}

try {
  const exists = await Room.findById(id).lean();
  if (exists) {
    console.log('Room already exists with id:', id);
    process.exit(0);
  }

  const doc = new Room({
    _id: id,
    name,
    description: args.description || '',
    type,
    owner,
    createdBy: owner,
    createdBySystem: owner === 'system',
    participants: args.participants ? args.participants.split(',') : [],
    members: args.members ? args.members.split(',') : [],
    settings: {},
    category
  });

  const saved = await doc.save();
  console.log('Created room:', saved._id);
  process.exit(0);
} catch (err) {
  console.error('Failed to create room', err?.message || err);
  console.error(err);
  process.exit(1);
}
