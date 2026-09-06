import { Queue, Worker } from 'bullmq';
import { createRedisClient } from '../config/redis.js';
import redis from '../config/redis.js';
import { query } from '../config/db.js';

const connection = createRedisClient();

export const transcriptQueue = new Queue('transcript-flush', { connection });

/**
 * Flush a single ticket's buffer to Postgres.
 * Returns true if flushed, false if no buffer found.
 */
export const forceFlushTranscript = async (ticketId) => {
  const originalKey = `chat:buffer:${ticketId}`;
  const processingKey = `chat:buffer_processing:${ticketId}`;

  // 1. Rename atomically to capture the current state of the buffer
  try {
    const renamed = await redis.renamenx(originalKey, processingKey);
    if (!renamed) {
      // Key didn't exist or processingKey already existed (extremely rare collision)
      return false;
    }
  } catch (err) {
    if (err.message.includes('no such key')) {
      return false;
    }
    throw err;
  }

  // 2. Read all messages
  const rawMessages = await redis.lrange(processingKey, 0, -1);
  if (rawMessages.length === 0) {
    await redis.del(processingKey);
    return false;
  }

  const messages = rawMessages.map((msg) => JSON.parse(msg));

  // 3. Bulk Insert into DB
  const values = [];
  const queryParams = [];
  let paramIndex = 1;

  for (const msg of messages) {
    values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
    queryParams.push(msg.id, msg.ticket_id, msg.sender_id, msg.sender_role, msg.body, msg.created_at);
  }

  await query(
    `INSERT INTO messages (id, ticket_id, sender_id, sender_role, body, sent_at) 
     VALUES ${values.join(', ')}`,
    queryParams
  );

  // 4. Update the ticket's updated_at timestamp to indicate activity
  //    and clear waiting_on_customer since someone sent a message!
  await query(
    `UPDATE tickets SET updated_at = NOW(), waiting_on_customer = false WHERE id = $1`,
    [ticketId]
  );

  // 5. Clean up the processing key and invalidate cache (M11.T3)
  await redis.del(processingKey);
  await redis.del(`cache:ticket_history:${ticketId}`);
  return true;
};

export const transcriptWorker = new Worker('transcript-flush', async (job) => {
  if (job.name === 'flush-buffers') {
    // console.log('[Worker] Running transcript flush cron job...');
    try {
      // Find all buffer keys
      let keys = [];
      let cursor = '0';
      do {
        const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', 'chat:buffer:*', 'COUNT', 100);
        cursor = nextCursor;
        keys.push(...batch);
      } while (cursor !== '0');

      if (keys.length === 0) return;

      for (const key of keys) {
        const ticketId = key.split(':')[2];
        await forceFlushTranscript(ticketId).catch((err) => {
          console.error(`[Worker] Failed to flush transcript for ticket ${ticketId}:`, err);
        });
      }
    } catch (err) {
      console.error('[Worker] Error running transcript-flush:', err);
    }
  }
}, { connection });

const IS_SCHEDULER = process.env.PORT === '3001';

if (IS_SCHEDULER) {
  transcriptQueue.add('flush-buffers', {}, {
    repeat: {
      pattern: '*/30 * * * * *' // Every 30 seconds
    },
    jobId: 'flush-buffers-cron'
  });
}

transcriptWorker.on('failed', (job, err) => {
  console.error(`[Worker] Transcript flush job failed:`, err.message);
});
