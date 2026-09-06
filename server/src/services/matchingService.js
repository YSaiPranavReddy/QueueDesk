/**
 * Matching Service — M3 (the core hard problem)
 *
 * The atomicity guarantee:
 *   The availability-check-and-match (or queue-insert) MUST be a single
 *   Redis operation — otherwise two customers connecting simultaneously
 *   can both see the same agent as "free" and both get matched to them.
 *   A Lua script runs atomically on the Redis server; no other command
 *   can interleave between the SPOP and the HSET.
 *
 * Redis key schema:
 *   agents:available           — Set of agentIds currently available
 *   agent:status:{agentId}     — Hash { status: available|busy|offline }
 *   queue:support              — Sorted set, score = join timestamp (FIFO)
 *   queue:avgHandleTime        — String, rolling average handle time in ms
 */
import redis from '../config/redis.js';
import { assignTicket, findTicketById } from '../models/ticket.js';
import { logger } from '../utils/logger.js';
import { 
  ticketsMatchedTotal, 
  ticketsQueuedTotal, 
  ticketClaimConflictsTotal,
  claimLatencySeconds,
  queueDepth,
  activeAgents,
  idleAgents,
  availableAgentsSetSize
} from '../utils/metrics.js';

// ── Lua script: atomic match-or-enqueue ──────────────────────────────────────
//
// KEYS[1] = 'agents:available'
// ARGV[1] = now (current timestamp)
// ARGV[2] = insertScore (priority-adjusted timestamp)
// ARGV[3] = customerId
// ARGV[4] = 'queue:support'
//
// Returns:
//   {1, agentId}   → instant match: agentId was popped and is now busy
//   {0, position}  → queued: 1-indexed position in queue
const MATCH_OR_ENQUEUE_SCRIPT = `
local now = ARGV[1]
local insertScore = ARGV[2]
local cutoff = now - 120000
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)

local agent = redis.call('ZPOPMIN', KEYS[1], 1)
if #agent > 0 then
    local agentId = agent[1]
    redis.call('HSET', 'agent:status:' .. agentId, 'status', 'busy')
    redis.call('EXPIRE', 'agent:status:' .. agentId, 120)
    return {1, agentId}
else
    redis.call('ZADD', ARGV[4], insertScore, ARGV[3])
    local pos = redis.call('ZRANK', ARGV[4], ARGV[3])
    return {0, tostring(pos + 1)}
end
`;

// ── Lua script: atomic free-agent-and-dequeue ─────────────────────────────────
//
// When an agent finishes a ticket, atomically:
//   1. Try to pop the next customer from their sticky queue (queue:sticky:{agentId})
//   2. If sticky queue is empty, try to pop from global queue
//   3. If global queue is empty → mark agent available again
//   4. If customer found → assign agent to them (stay busy)
//
// KEYS[1] = 'queue:support'
// KEYS[2] = 'agents:available'
// KEYS[3] = 'queue:sticky:' .. ARGV[1]
// ARGV[1] = agentId
// ARGV[2] = timestamp
//
// Returns:
//   {1, customerId}  → next customer dequeued (sticky or global), agent stays busy
//   {0, ''}          → both queues empty, agent marked available
const FREE_AGENT_SCRIPT = `
local nextSticky = redis.call('ZPOPMIN', KEYS[3], 1)
if #nextSticky > 0 then
    local customerId = nextSticky[1]
    redis.call('HSET', 'agent:status:' .. ARGV[1], 'status', 'busy')
    redis.call('EXPIRE', 'agent:status:' .. ARGV[1], 120)
    return {1, customerId}
end

local next = redis.call('ZPOPMIN', KEYS[1], 1)
if #next > 0 then
    local customerId = next[1]
    redis.call('HSET', 'agent:status:' .. ARGV[1], 'status', 'busy')
    redis.call('EXPIRE', 'agent:status:' .. ARGV[1], 120)
    return {1, customerId}
else
    redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
    redis.call('HSET', 'agent:status:' .. ARGV[1], 'status', 'available')
    redis.call('EXPIRE', 'agent:status:' .. ARGV[1], 120)
    return {0, ''}
end
`;

// ── Lua script: atomic sticky-match-or-enqueue ───────────────────────────────
//
// When a customer replies to a sticky (on-hold) ticket:
//   1. Check if the specific agent is available
//   2. If available, match instantly and mark agent busy
//   3. If busy, enqueue in the agent's sticky queue
//
// KEYS[1] = 'agents:available'
// ARGV[1] = timestamp
// ARGV[2] = customerId
// ARGV[3] = agentId
// ARGV[4] = 'queue:sticky:' .. agentId
//
// Returns:
//   {1, agentId}  → matched instantly
//   {0, position} → queued in sticky queue
const MATCH_STICKY_SCRIPT = `
local cutoff = ARGV[1] - 120000
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)

local score = redis.call('ZSCORE', KEYS[1], ARGV[3])
if score then
    redis.call('ZREM', KEYS[1], ARGV[3])
    redis.call('HSET', 'agent:status:' .. ARGV[3], 'status', 'busy')
    redis.call('EXPIRE', 'agent:status:' .. ARGV[3], 120)
    return {1, ARGV[3]}
else
    redis.call('ZADD', ARGV[4], ARGV[1], ARGV[2])
    local pos = redis.call('ZRANK', ARGV[4], ARGV[2])
    return {0, tostring(pos + 1)}
end
`;

const QUEUE_KEY    = 'queue:support';
const AVAIL_KEY    = 'agents:available';
const AVG_TIME_KEY = 'queue:avgHandleTime';
const DEFAULT_AVG_HANDLE_MS = 5 * 60 * 1000; // 5 min default

// ── matchOrEnqueue ────────────────────────────────────────────────────────────
/**
 * Core routing decision for a new customer ticket.
 *
 * Runs the Lua script atomically:
 *  - If an agent is free  → instant match, returns { matched: true, agentId }
 *  - If no agent is free  → joins queue, returns { matched: false, position, estimatedWaitMs }
 *
 * @param {string} customerId
 * @param {string} ticketId   — the already-created pending ticket
 * @returns {Promise<{ matched: boolean, agentId?: string, position?: number, estimatedWaitMs?: number }>}
 */
export const matchOrEnqueue = async (customerId, ticketId) => {
  const timestamp = Date.now();

  const result = await redis.eval(
    MATCH_OR_ENQUEUE_SCRIPT,
    1,
    AVAIL_KEY,
    timestamp,    // ARGV[1]: now
    timestamp,    // ARGV[2]: insertScore (same as now for fresh ticket)
    customerId,   // ARGV[3]
    QUEUE_KEY     // ARGV[4]
  );

  const [matched, value] = result;

  if (matched === 1) {
    const agentId = value;
    
    try {
      await assignTicket(ticketId, agentId);
      ticketsMatchedTotal.inc();
      const ticket = await findTicketById(ticketId);
      if (ticket) claimLatencySeconds.observe((Date.now() - new Date(ticket.created_at).getTime()) / 1000);
    } catch (err) {
      if (err.name === 'ConcurrencyError') {
        logger.warn({ err, ticketId, agentId }, `[Matching] Ticket ${ticketId} already claimed elsewhere, rolling back agent ${agentId} to available pool.`);
        ticketClaimConflictsTotal.inc();
      } else {
        logger.error({ err, ticketId, agentId }, '[Matching] assignTicket failed after Redis match, rolling back');
      }
      const { releaseAgent } = await import('./claimService.js');
      await releaseAgent(agentId); // properly handles serving next queued customer if queue isn't empty
      throw err; // let caller know the match failed
    }

    // Notify customer + agent via WebSocket
    try {
      const { emitTicketMatched, emitTicketAssigned, joinAgentToTicketRoom, joinCustomerToTicketRoom } = await import('../socket/index.js');
      const { findUserById } = await import('../models/user.js');
      const { findTicketById } = await import('../models/ticket.js');
      const [agent, ticket] = await Promise.all([findUserById(agentId), findTicketById(ticketId)]);
      emitTicketMatched(customerId, ticketId, agentId, agent?.name || 'Agent');
      emitTicketAssigned(agentId, ticket);
      await joinAgentToTicketRoom(agentId, ticketId);
      await joinCustomerToTicketRoom(customerId, ticketId);

      const { sendTicketAssigned } = await import('./notificationService.js');
      await sendTicketAssigned(ticketId);
    } catch (_) { /* socket not yet initialized in tests */ }

    return { matched: true, agentId };
  }

  ticketsQueuedTotal.inc();
  const position = parseInt(value, 10);
  const estimatedWaitMs = await getEstimatedWait(position);

  // Push initial queue position to customer + notify agents of the new pending ticket
  try {
    const { emitQueuePosition, emitTicketPending } = await import('../socket/index.js');
    const { findTicketById } = await import('../models/ticket.js');

    emitQueuePosition(customerId, position, estimatedWaitMs);

    const ticket = await findTicketById(ticketId);
    if (ticket) emitTicketPending(ticket);
  } catch (_) { /* socket not yet initialized in tests */ }

  return { matched: false, position, estimatedWaitMs };
};


// ── recirculateCustomer ───────────────────────────────────────────────────────
/**
 * Puts a customer back at the absolute front of the queue (score 0), 
 * OR instantly matches them if an agent is already idle.
 * Uses MATCH_OR_ENQUEUE_SCRIPT for safety.
 */
const RECIRCULATE_PRIORITY_OFFSET = 1e14; // comfortably larger than any real Date.now()

export const recirculateCustomer = async (customerId) => {
  const priorityScore = Date.now() - RECIRCULATE_PRIORITY_OFFSET; // always negative, still monotonic
  const result = await redis.eval(
    MATCH_OR_ENQUEUE_SCRIPT,
    1,
    AVAIL_KEY,
    Date.now(),     // ARGV[1]: now
    priorityScore,  // ARGV[2]: insertScore (massively negative for front-of-queue)
    customerId,     // ARGV[3]
    QUEUE_KEY       // ARGV[4]
  );

  const [matched, value] = result;

  if (matched === 1) {
    return { matched: true, agentId: value };
  }

  ticketsQueuedTotal.inc();
  const position = parseInt(value, 10);
  const estimatedWaitMs = await getEstimatedWait(position);

  return { matched: false, position, estimatedWaitMs };
};


// ── freeAgent ─────────────────────────────────────────────────────────────────
/**
 * Called when an agent finishes a ticket (ticket closed or agent disconnects).
 * Atomically serves the next waiting customer OR marks agent available.
 *
 * @param {string} agentId
 * @param {string|null} closedTicketId — for avg handle time tracking
 * @returns {Promise<{ served: boolean, customerId?: string }>}
 */
export const freeAgent = async (agentId, closedTicketId = null) => {
  const result = await redis.eval(
    FREE_AGENT_SCRIPT,
    3,          // number of KEYS
    QUEUE_KEY,  // KEYS[1]
    AVAIL_KEY,  // KEYS[2]
    `queue:sticky:${agentId}`, // KEYS[3]
    agentId,    // ARGV[1]
    Date.now()  // ARGV[2]
  );

  const [served, customerId] = result;

  if (served === 1) {
    return { served: true, customerId };
  }

  return { served: false };
};

// ── Queue position ────────────────────────────────────────────────────────────
/**
 * Get a customer's current 1-indexed position in the queue.
 * Returns null if they are not in the queue (already matched or not yet queued).
 *
 * @param {string} customerId
 * @returns {Promise<number|null>}
 */
export const getQueuePosition = async (customerId) => {
  const rank = await redis.zrank(QUEUE_KEY, customerId);
  return rank !== null ? rank + 1 : null;
};

/**
 * Get the full ordered list of waiting customers.
 * Used to broadcast position updates to all waiting customers after a dequeue.
 *
 * @returns {Promise<string[]>} Array of customerIds in queue order
 */
export const getQueueMembers = async () => {
  return redis.zrange(QUEUE_KEY, 0, -1);
};

/**
 * Estimated wait time for a given queue position.
 * Based on rolling average handle time stored in Redis.
 *
 * @param {number} position - 1-indexed queue position
 * @returns {Promise<number>} Estimated wait in milliseconds
 */
export const getEstimatedWait = async (position) => {
  const avg = await redis.get(AVG_TIME_KEY);
  const avgMs = avg ? parseInt(avg, 10) : DEFAULT_AVG_HANDLE_MS;
  return position * avgMs;
};

/**
 * Batch version of getEstimatedWait to avoid N sequential Redis round-trips.
 *
 * @param {number[]} positions - Array of 1-indexed queue positions
 * @returns {Promise<number[]>} Array of estimated waits in milliseconds
 */
export const getEstimatedWaitBatch = async (positions) => {
  const avg = await redis.get(AVG_TIME_KEY);
  const avgMs = avg ? parseInt(avg, 10) : DEFAULT_AVG_HANDLE_MS;
  return positions.map((p) => p * avgMs);
};

// ── Average Handle Time (M11.T2) ──────────────────────────────────────────────
export const updateAvgHandleTime = async (durationMs) => {
  if (durationMs <= 0 || durationMs > 24 * 60 * 60 * 1000) return; // ignore invalid or > 1 day times

  const currentAvgStr = await redis.get(AVG_TIME_KEY);
  let newAvg;
  
  if (!currentAvgStr) {
    newAvg = durationMs;
  } else {
    // Exponential Moving Average (EMA) - favors recent times
    // new_avg = (current * 0.9) + (new * 0.1)
    const currentAvg = parseInt(currentAvgStr, 10);
    newAvg = Math.floor(currentAvg * 0.9 + durationMs * 0.1);
  }
  
  await redis.set(AVG_TIME_KEY, newAvg);
};

// ── Agent availability management ─────────────────────────────────────────────
/**
 * Mark an agent as available — called on WebSocket connect or status toggle.
 * Uses FREE_AGENT_SCRIPT to atomically check the queue and mark available,
 * OR immediately match with a waiting customer.
 *
 * @param {string} agentId
 * @returns {Promise<{ served: boolean, customerId?: string }>}
 */
export const markAgentAvailable = freeAgent; // same operation, kept as an alias for call-site clarity

/**
 * Mark an agent as offline — remove from available set.
 *
 * @param {string} agentId
 */
export const markAgentOffline = async (agentId) => {
  const multi = redis.multi();
  multi.hset(`agent:status:${agentId}`, 'status', 'offline');
  multi.expire(`agent:status:${agentId}`, 120); // M11.T1: TTL applies even to offline state
  multi.zrem(AVAIL_KEY, agentId);
  await multi.exec();
};

export const refreshAgentTTL = async (agentId) => {
  const multi = redis.multi();
  multi.expire(`agent:status:${agentId}`, 120);
  multi.zadd(AVAIL_KEY, 'XX', 'CH', Date.now(), agentId); // Update score only if they are already in the available set
  await multi.exec();
};

/**
 * Remove a customer from the queue (they disconnected mid-wait).
 *
 * @param {string} customerId
 */
export const removeFromQueue = async (customerId) => {
  await redis.zrem(QUEUE_KEY, customerId);
};

/**
 * Get the current Redis status of an agent.
 *
 * @param {string} agentId
 * @returns {Promise<string>} 'available' | 'busy' | 'offline' | 'unknown'
 */
export const getAgentStatus = async (agentId) => {
  const status = await redis.hget(`agent:status:${agentId}`, 'status');
  return status || 'unknown';
};

/**
 * Get status for multiple agents at once (used by admin dashboard).
 *
 * @param {string[]} agentIds
 * @returns {Promise<Record<string, string>>} Map of agentId → status
 */
export const getAgentStatusMap = async (agentIds) => {
  if (!agentIds.length) return {};

  const pipeline = redis.pipeline();
  agentIds.forEach((id) => pipeline.hget(`agent:status:${id}`, 'status'));
  const results = await pipeline.exec();

  return Object.fromEntries(
    agentIds.map((id, i) => [id, results[i][1] || 'unknown'])
  );
};

// ── routeStickyTicket ─────────────────────────────────────────────────────────
/**
 * Attempt to instantly route a returning on-hold customer to their original agent.
 * If the agent is busy, puts them in the agent's sticky queue.
 *
 * @param {string} customerId
 * @param {string} ticketId
 * @param {string} agentId
 */
export const routeStickyTicket = async (customerId, ticketId, agentId) => {
  const timestamp = Date.now();
  const stickyQueueKey = `queue:sticky:${agentId}`;

  const result = await redis.eval(
    MATCH_STICKY_SCRIPT,
    1,
    AVAIL_KEY,
    timestamp,
    customerId,
    agentId,
    stickyQueueKey
  );

  const [matched, value] = result;

  if (matched === 1) {
    try {
      await assignTicket(ticketId, agentId);
      ticketsMatchedTotal.inc();
      const ticket = await findTicketById(ticketId);
      if (ticket) claimLatencySeconds.observe((Date.now() - new Date(ticket.created_at).getTime()) / 1000);
    } catch (err) {
      if (err.name === 'ConcurrencyError') {
        logger.warn({ err, ticketId, agentId }, `[Matching] Sticky ticket ${ticketId} already claimed elsewhere, rolling back agent ${agentId} to available pool.`);
        ticketClaimConflictsTotal.inc();
      } else {
        logger.error({ err, ticketId, agentId }, '[Matching] assignTicket failed for sticky route, rolling back');
      }
      const { releaseAgent } = await import('./claimService.js');
      await releaseAgent(agentId);
      throw err;
    }

    try {
      const { emitTicketMatched, emitTicketAssigned, joinAgentToTicketRoom, joinCustomerToTicketRoom } = await import('../socket/index.js');
      const { findUserById } = await import('../models/user.js');
      const { findTicketById } = await import('../models/ticket.js');
      const [agent, ticket] = await Promise.all([findUserById(agentId), findTicketById(ticketId)]);
      emitTicketMatched(customerId, ticketId, agentId, agent?.name || 'Agent');
      emitTicketAssigned(agentId, ticket);
      await joinAgentToTicketRoom(agentId, ticketId);
      await joinCustomerToTicketRoom(customerId, ticketId);

      const { sendTicketAssigned } = await import('./notificationService.js');
      await sendTicketAssigned(ticketId);
    } catch (_) { /* socket not initialized */ }

    return { matched: true, agentId };
  }

  const position = parseInt(value, 10);
  return { matched: false, position };
};
