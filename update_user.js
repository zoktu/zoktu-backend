import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { env } from './src/config/env.js';

async function update() {
  await mongoose.connect(env.mongoUri);
  const result = await mongoose.connection.collection('users').updateOne(
    { email: 'rohitbansal23rk@gmail.com' },
    { $set: { emailVerified: true, userType: 'registered' } }
  );
  console.log("Update result:", result);
  process.exit(0);
}

update().catch(console.error);
