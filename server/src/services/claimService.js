/**
 * Claim Service — M5
 *
 * Problem: Two agents see the same pending ticket simultaneously and both click Claim.
 * Without a lock, both requests hit the DB at the same time → both succeed → double-assign.
 *
 * Solution: Redis SET NX EX (set-if-not-exists with TTL)
 *   - Key: lock:ticket:{ticketId}
 *   - Value: agentId (who holds the lock)
 *   - TTL: 10 seconds (auto-release if agent crashes mid-claim)
 *
 * If SET NX succeeds → this agent won the race → proceed to DB assign
 * If SET NX fails    → another agent already claimed it → return 409 Conflict
 *
 * The lock is released (DEL) after DB write completes.
 * TTL is a safety net — prevents zombie locks from stuck agents.
 */
import redis from "../config/redis.js";
import {
  assignTicket,
  findTicketById,
  findPendingTicketByCustomerId,
  unassignTicket,
  findTickets,
} from "../models/ticket.js";
import { freeAgent } from "./matchingService.js";
import { logger } from "../utils/logger.js";
import { claimLatencySeconds, ticketClaimConflictsTotal, ticketsMatchedTotal } from "../utils/metrics.js";

const LOCK_TTL_SECONDS = 10;
const lockKey = (ticketId) => `lock:ticket:${ticketId}`;

/**
 * Atomically claim a ticket for an agent.
 *
 * Flow:
 *   1. SET NX EX lock key → only one agent wins
 *   2. Verify ticket is still pending (race safety double-check)
 *   3. Assign in DB
 *   4. Release lock
 *
 * @param {string} ticketId
 * @param {string} agentId
 * @returns {Promise<{ success: true, ticket: object } | { success: false, reason: string }>}
 */
export const claimTicket = async (ticketId, agentId) => {
  const { getAgentStatus } = await import('./matchingService.js');
  const { findTickets } = await import('../models/ticket.js');

  const status = await getAgentStatus(agentId);
  if (status === 'offline' || status === 'unknown') {
    return { success: false, reason: 'agent_offline' };
  }

  const MAX_CONCURRENT_TICKETS = 5; // tune as you like
  const activeTickets = await findTickets({ agentId, status: 'assigned' });
  if (activeTickets.length >= MAX_CONCURRENT_TICKETS) {
    return { success: false, reason: 'ticket_limit_reached' };
  }

  const key = lockKey(ticketId);

  // Atomic SET NX EX — returns 'OK' if we won, null if already locked
  const acquired = await redis.set(key, agentId, "EX", LOCK_TTL_SECONDS, "NX");

  if (!acquired) {
    // Another agent is mid-claim — or has already claimed it
    logger.warn({ ticketId, agentId }, `Ticket locked by another agent (Redis NX constraint hit)`);
    ticketClaimConflictsTotal.inc();
    return { success: false, reason: "ticket_locked" };
  }

  try {
    // Double-check ticket is still claimable (could have been matched via Lua before lock)
    const ticket = await findTicketById(ticketId);

    if (!ticket) {
      return { success: false, reason: "not_found" };
    }

    if (ticket.status !== "pending") {
      // Already assigned/closed — someone else got it
      return {
        success: false,
        reason: "already_claimed",
        currentStatus: ticket.status,
      };
    }

    if (ticket.agent_id && ticket.agent_id !== agentId) {
      logger.warn({ ticketId, agentId }, `Ticket already assigned to someone else`);
      ticketClaimConflictsTotal.inc();
      return { success: false, reason: "already_claimed" };
    }

    // We hold the lock AND ticket is pending — safe to assign
    const assigned = await assignTicket(ticketId, agentId);
    
    // M12.T2: Record claim latency
    claimLatencySeconds.observe((Date.now() - new Date(ticket.created_at).getTime()) / 1000);

    return { success: true, ticket: assigned };
  } catch (err) {
    if (err.name === 'ConcurrencyError') {
      logger.warn({ err, ticketId, agentId }, `Ticket ${ticketId} already claimed elsewhere`);
      ticketClaimConflictsTotal.inc();
      return { success: false, reason: 'already_claimed' };
    }
    logger.error({ err, ticketId, agentId }, 'Failed to claim ticket');
    throw err;
  } finally {
    // Always release the lock — even if an error occurred above
    await redis.del(key);
  }
};

/**
 * Helper to assign a popped customer's ticket to an agent.
 */
export const assignNextInQueue = async (agentId, customerId) => {
  const ticket = await findPendingTicketByCustomerId(customerId);
  if (!ticket) {
    // Rollback: The agent was marked busy, but the customer had no pending ticket.
    // Put the agent back into circulation.
    const { markAgentAvailable } = await import("./matchingService.js");
    await markAgentAvailable(agentId);
    return null;
  }

  let assigned;
  try {
    assigned = await assignTicket(ticket.id, agentId);
    ticketsMatchedTotal.inc();
    claimLatencySeconds.observe((Date.now() - new Date(ticket.created_at).getTime()) / 1000);
  } catch (err) {
    if (err.name === 'ConcurrencyError') {
      logger.warn({ err, ticketId: ticket.id, agentId }, `[Matching] Ticket ${ticket.id} already claimed elsewhere, rolling back agent ${agentId} to available pool.`);
      ticketClaimConflictsTotal.inc();
    } else {
      logger.error({ err, ticketId: ticket.id, agentId }, '[Matching] assignTicket failed in assignNextInQueue, rolling back');
    }
    await releaseAgent(agentId, null);
    throw err;
  }

  try {
    const {
      emitTicketMatched,
      emitTicketAssigned,
      joinAgentToTicketRoom,
      joinCustomerToTicketRoom,
      broadcastQueueShift,
    } = await import("../socket/index.js");
    const { findUserById } = await import("../models/user.js");
    const { getQueueMembers } = await import("./matchingService.js");

    const agent = await findUserById(agentId);

    // Notify the lucky customer
    emitTicketMatched(customerId, ticket.id, agentId, agent?.name || "Agent");

    const { sendTicketAssigned } = await import('./notificationService.js');
    await sendTicketAssigned(ticket.id);

    // Notify the agent
    emitTicketAssigned(agentId, assigned);
    await joinAgentToTicketRoom(agentId, ticket.id);
    await joinCustomerToTicketRoom(customerId, ticket.id);

    // M11.T2: Shift the rest of the queue instantly (supplements statsWorker's 10s poll)
    const remaining = await getQueueMembers();
    if (remaining.length > 0) {
      await broadcastQueueShift(remaining);
    }
  } catch (_) {
    /* socket optional */
  }

  return assigned;
};

/**
 * Release an agent after closing a ticket.
 * Calls freeAgent() which atomically:
 *   - Pops the next waiting customer from the queue (serves them), or
 *   - Marks the agent available again
 *
 * Also emits WebSocket events (ticket:closed, queue:position shift).
 *
 * @param {string} agentId
 * @param {string} closedTicketId
 * @returns {Promise<{ served: boolean, customerId?: string }>}
 */
export const releaseAgent = async (agentId, closedTicketId) => {
  const result = await freeAgent(agentId, closedTicketId);

  if (result.served) {
    // A waiting customer was dequeued — assign their ticket!
    await assignNextInQueue(agentId, result.customerId);
  }

  return result;
};

/**
 * Recirculate an active ticket back to the front of the queue.
 * Used when an agent disconnects and their grace period expires.
 */
export const routePendingTicket = async (ticket) => {
  try {
    const { recirculateCustomer } = await import("./matchingService.js");
    const {
      emitQueuePosition,
      broadcastQueueShift,
      emitTicketMatched,
      emitTicketAssigned,
      joinAgentToTicketRoom,
      joinCustomerToTicketRoom,
    } = await import("../socket/index.js");
    const { getQueueMembers } = await import("./matchingService.js");

    // Fast-path check: is an agent idle right now?
    const result = await recirculateCustomer(ticket.customer_id);

    if (result.matched) {
      // An agent was idle and just got marked busy! Assign the ticket to them.
      let assigned;
      try {
        assigned = await assignTicket(ticket.id, result.agentId);
        ticketsMatchedTotal.inc();
        claimLatencySeconds.observe((Date.now() - new Date(ticket.created_at).getTime()) / 1000);
      } catch (err) {
        if (err.name === 'ConcurrencyError') {
          logger.warn({ err, ticketId: ticket.id, agentId: result.agentId }, `[Matching] Ticket ${ticket.id} already claimed elsewhere, rolling back agent ${result.agentId} to available pool.`);
          ticketClaimConflictsTotal.inc();
        } else {
          logger.error({ err, ticketId: ticket.id, agentId: result.agentId }, '[Matching] assignTicket failed in recirculateTicket, rolling back');
        }
        await releaseAgent(result.agentId, null);
        throw err;
      }

      const { findUserById } = await import("../models/user.js");
      const agent = await findUserById(result.agentId);

      emitTicketMatched(
        ticket.customer_id,
        ticket.id,
        result.agentId,
        agent?.name || "Agent",
      );
      emitTicketAssigned(result.agentId, assigned);
      await joinAgentToTicketRoom(result.agentId, ticket.id);
      await joinCustomerToTicketRoom(ticket.customer_id, ticket.id);

      const { sendTicketAssigned } = await import('./notificationService.js');
      await sendTicketAssigned(ticket.id);
    } else {
      // No agents free, customer placed at the front of the queue
      emitQueuePosition(
        ticket.customer_id,
        result.position,
        result.estimatedWaitMs,
      );

      const { emitTicketPending, broadcastQueueShift } = await import('../socket/index.js');
      emitTicketPending(ticket);

      // Inform everyone else that the queue shifted instantly
      const remaining = await getQueueMembers();
      if (remaining.length > 0) {
        await broadcastQueueShift(remaining);
      }
    }
    return result;
  } catch (err) {
    logger.error({ err, ticketId: ticket.id }, '[Matching] routePendingTicket failed');
  }
};

/**
 * Recirculate an active ticket back to the front of the queue.
 * Used when an agent disconnects and their grace period expires.
 */
export const recirculateTicket = async (ticketId) => {
  const ticket = await unassignTicket(ticketId);
  if (!ticket) return;
  return await routePendingTicket(ticket);
};
