import { createRedisClient } from '../config/redis.js';
import { getIo } from '../socket/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { queueDepth, availableAgentsSetSize, activeAgents, idleAgents } from '../utils/metrics.js';
import { query } from '../config/db.js';

const redis = createRedisClient();

const QUEUE_KEY = 'queue:support';
const AVG_TIME_KEY = 'queue:avgHandleTime';
const DEFAULT_AVG_HANDLE_MS = 5 * 60 * 1000; // 5 mins

export const startStatsWorker = () => {
  // Only run this on the primary node to avoid duplicate broadcasts
  if (process.env.PORT !== '3001') return;

  logger.info('[StatsWorker] Starting 10s queue stats interval');

  setInterval(async () => {
    try {
      // 1. Get current queue length
      const queueLength = await redis.zcard(QUEUE_KEY);
      queueDepth.set(queueLength);

      // 1b. Update other Gauges for metrics
      const availSetSize = await redis.zcard('agents:available');
      availableAgentsSetSize.set(availSetSize);
      idleAgents.set(availSetSize);
      
      const res = await query(`
        SELECT COUNT(DISTINCT agent_id) as active
        FROM tickets 
        WHERE status = 'assigned'
      `);
      if (res.rows.length > 0) {
        activeAgents.set(parseInt(res.rows[0].active, 10));
      }

      // 2. Get current average handle time
      const avgStr = await redis.get(AVG_TIME_KEY);
      const avgHandleTimeMs = avgStr ? parseInt(avgStr, 10) : DEFAULT_AVG_HANDLE_MS;

      // 3. Calculate estimated wait for the LAST person in queue
      const estimatedWaitMs = queueLength * avgHandleTimeMs;

      // 4. Cache it
      const stats = {
        queueLength,
        estimatedWaitMs,
        avgHandleTimeMs,
        updatedAt: Date.now()
      };
      await redis.setex('queue:stats', 15, JSON.stringify(stats));

      // 5. Broadcast to all waiting customers
      const waitingCustomerIds = await redis.zrange(QUEUE_KEY, 0, -1);
      
      if (waitingCustomerIds.length > 0) {
        const io = getIo();
        for (let i = 0; i < waitingCustomerIds.length; i++) {
          const customerId = waitingCustomerIds[i];
          const pos = i + 1; // 1-indexed
          const waitTime = pos * avgHandleTimeMs;
          
          io.to(`customer:${customerId}`).emit('queue:position', {
            position: pos,
            estimatedWaitMs: waitTime
          });
        }
      }
    } catch (err) {
      logger.error({ err }, '[StatsWorker] Error broadcasting stats');
    }
  }, 10000);
};
