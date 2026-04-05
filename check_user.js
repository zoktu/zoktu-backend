import dotenv from 'dotenv';
dotenv.config();
import { connectDb } from './src/config/db.js';
import User from './src/models/User.js';

async function run() {
  await connectDb();
  const user = await User.findOne({ email: 'rohitbansal23rk@gmail.com' });
  console.log(user);
  process.exit(0);
}

run().catch(console.error);
