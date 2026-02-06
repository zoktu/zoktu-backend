#!/usr/bin/env node
import { connectDb } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import Room from '../src/models/Room.js';

async function seed() {
  console.log('Using MONGO_URI:', process.env.MONGO_URI || env.mongoUri);
  try {
    await connectDb();
    console.log('DB connection established');
  } catch (e) {
    console.error('DB connection failed', e?.message || e);
    process.exit(1);
  }
  const id = 'system-welcome';
  try {
    const exists = await Room.findById(id).lean();
    if (exists) {
      console.log('System room already exists:', id);
      process.exit(0);
    }

    const doc = new Room({
      _id: id,
      name: 'Welcome to Zoktu',
      description: 'Official system room — announcements, help, and community updates.',
      type: 'public',
      owner: 'system',
      createdBy: 'system',
      createdBySystem: true,
      participants: [],
      members: [],
      settings: {},
      category: 'general'
    });

    const saved = await doc.save();
    console.log('Seeded system room:', id, 'saved:', Boolean(saved && saved._id));
    process.exit(0);
  } catch (err) {
    console.error('Failed to seed system room', err?.message || err);
    // show full error stack for diagnostics
    console.error(err);
    process.exit(1);
  }
}

seed();
