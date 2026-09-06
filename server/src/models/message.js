/**
 * Message model — DB query functions for the messages table.
 *
 * NOTE on persistence strategy (M6.T2):
 * Messages are buffered in Redis Lists during live chat and batch-flushed
 * to this table every 30s by the transcript-flush worker (M9.T2).
 * These query functions are used by:
 *  - GET /api/tickets/:id/messages  → reconnect history fetch
 *  - transcript-flush worker        → batch insert
 *  - ticket close                   → force-flush
 */
import { query, getClient } from '../config/db.js';
import redis from '../config/redis.js';

/**
 * Fetch message history for a ticket, ordered oldest-first.
 * Used on reconnect so the client can catch up.
 *
 * @param {string} ticketId
 * @param {number} limit
 * @param {string|null} before - ISO timestamp cursor for pagination
 */
export const findMessagesByTicket = async (ticketId, { limit = 100, before = null } = {}) => {
  const CACHE_KEY = `cache:ticket_history:${ticketId}`;

  // M11.T3: If requesting the latest messages (no pagination cursor), try cache first
  if (!before) {
    const cachedStr = await redis.get(CACHE_KEY);
    if (cachedStr) {
      try {
        return JSON.parse(cachedStr);
      } catch (_) {}
    }
  }

  const params = [ticketId, limit];
  let cursor = '';

  if (before) {
    params.push(before);
    cursor = `AND m.sent_at < $${params.length}`;
  }

  const { rows } = await query(
    `SELECT m.id, m.ticket_id, m.sender_id, m.body, m.sent_at, m.read_at,
            u.name AS sender_name, u.role AS sender_role
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.ticket_id = $1 ${cursor}
     ORDER BY m.sent_at ASC
     LIMIT $2`,
    params
  );

  // M11.T3: Cache the result for 5 minutes (only for base query)
  if (!before) {
    await redis.setex(CACHE_KEY, 300, JSON.stringify(rows));
  }

  return rows;
};

/**
 * Insert a single message.
 * Accepts either the full message object (from chat handler) or simple fields.
 * ON CONFLICT DO NOTHING — idempotent if worker also tries to insert same id.
 */
export const insertMessage = async ({ id, ticket_id, ticketId, sender_id, senderId, body, created_at }) => {
  const tid = ticket_id || ticketId;
  const sid = sender_id || senderId;
  const { rows } = await query(
    `INSERT INTO messages (id, ticket_id, sender_id, body, sent_at)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, COALESCE($5::timestamptz, NOW()))
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [id || null, tid, sid, body, created_at || null]
  );
  return rows[0];
};


/**
 * Batch-insert messages from the Redis buffer flush.
 * Uses a single multi-row INSERT for efficiency.
 * Idempotent: ON CONFLICT DO NOTHING guards against double-flush on worker crash.
 *
 * @param {Array<{id, ticketId, senderId, body, sentAt}>} messages
 */
export const batchInsertMessages = async (messages) => {
  if (!messages.length) return;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Build parameterised multi-row insert
    const values = [];
    const placeholders = messages.map((m, i) => {
      const base = i * 5;
      values.push(m.id, m.ticketId, m.senderId, m.body, m.sentAt || new Date());
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });

    await client.query(
      `INSERT INTO messages (id, ticket_id, sender_id, body, sent_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (id) DO NOTHING`,
      values
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Mark a message as read.
 * Called when the recipient's socket acknowledges a message.
 */
export const markMessageRead = async (messageId) => {
  await query(
    'UPDATE messages SET read_at = NOW() WHERE id = $1 AND read_at IS NULL',
    [messageId]
  );
};
