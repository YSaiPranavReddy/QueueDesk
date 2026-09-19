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

  // Collect messages from both the main buffer and any stale processing key
  // (processing key may be left over from a previously interrupted flush)
  const allRaw = [];

  // Read and clear the main buffer atomically
  try {
    const renamed = await redis.renamenx(originalKey, processingKey);
    if (renamed) {
      // Successfully claimed the buffer - read it
      const raw = await redis.lrange(processingKey, 0, -1);
      allRaw.push(...raw);
      await redis.del(processingKey);
    }
    // If renamenx returned 0, processingKey already exists (stale from crashed flush)
    // We will handle that below
  } catch (err) {
    if (!err.message.includes('no such key')) throw err;
    // originalKey didn't exist — that's fine, no new messages
  }

  // Also recover any stale processing key that survived a previous crash
  try {
    const staleRaw = await redis.lrange(processingKey, 0, -1);
    if (staleRaw.length > 0) {
      allRaw.push(...staleRaw);
      await redis.del(processingKey);
    }
  } catch (_) {}

  if (allRaw.length === 0) return false;

  const messages = allRaw
    .map(msg => { try { return JSON.parse(msg); } catch { return null; } })
    .filter(Boolean);

  if (messages.length === 0) return false;

  // Deduplicate by message id before inserting
  const unique = [...new Map(messages.map(m => [m.id, m])).values()];

  // Bulk Insert into DB (ON CONFLICT DO NOTHING = idempotent)
  const values = [];
  const queryParams = [];
  let paramIndex = 1;

  for (const msg of unique) {
    values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
    queryParams.push(msg.id, msg.ticket_id, msg.sender_id, msg.sender_role, msg.body, msg.created_at);
  }

  await query(
    `INSERT INTO messages (id, ticket_id, sender_id, sender_role, body, sent_at) 
     VALUES ${values.join(', ')}
     ON CONFLICT (id) DO NOTHING`,
    queryParams
  );

  // Update ticket and clear cache
  await query(
    `UPDATE tickets SET updated_at = NOW(), waiting_on_customer = false WHERE id = $1`,
    [ticketId]
  );
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
