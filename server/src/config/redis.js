import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Build ioredis options.
 * 
 * In production (Upstash / any cloud Redis), REDIS_URL is a single
 * connection string like:  rediss://user:pass@host:port
 * ioredis handles TLS automatically when the scheme is "rediss://".
 *
 * In local dev (Docker), we fall back to REDIS_HOST + REDIS_PORT.
 */
const REDIS_URL = process.env.REDIS_URL;

const baseOptions = {
  maxRetriesPerRequest: null, // Required by BullMQ
  lazyConnect: true,
};

const createClient = (extraOptions = {}) => {
  if (REDIS_URL) {
    return new Redis(REDIS_URL, { ...baseOptions, ...extraOptions });
  }
  return new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    ...baseOptions,
    ...extraOptions,
  });
};

// Primary client — general purpose (get/set/pub/sub/lock commands)
const redis = createClient();

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err.message));

/**
 * Create a dedicated Redis client.
 * BullMQ and the Socket.IO adapter both require separate client instances.
 */
export const createRedisClient = (extraOptions = {}) => createClient(extraOptions);

export default redis;
