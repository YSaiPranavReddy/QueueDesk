import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null, // Required by BullMQ
  lazyConnect: true,
};

// Primary client — general purpose (get/set/pub/sub commands)
const redis = new Redis(redisConfig);

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err.message));

/**
 * Create a dedicated Redis client (for BullMQ workers, socket.io adapter, etc.)
 * BullMQ requires separate client instances for queue and worker.
 */
export const createRedisClient = () => new Redis(redisConfig);

export default redis;
