import Redis from 'ioredis';
import { env } from '../config/env.js';

// Single Redis client for commands; used for list enqueue and BRPOP in worker
const redis = new Redis(env.redisUrl || undefined);

export default redis;
