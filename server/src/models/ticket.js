/**
 * Ticket model — DB query functions for the tickets table.
 */
import { query } from '../config/db.js';
import { config } from '../config/index.js';
import { ConcurrencyError } from '../utils/errors.js';

/**
 * Create a new pending ticket for a customer.
 * Sets sla_deadline based on SLA_ESCALATION_MINUTES env config.
 */
export const createTicket = async ({ customerId, subject = 'Support Request', priority = 'normal' }) => {
  const { rows } = await query(
    `INSERT INTO tickets (customer_id, subject, priority, status, sla_deadline)
     VALUES ($1, $2, $3, 'pending', NOW() + ($4 || ' minutes')::interval)
     RETURNING *`,
    [customerId, subject, priority, config.sla.escalationMinutes]
  );
  return rows[0];
};

/**
 * Get a single ticket by ID.
 * Joins customer and agent name for convenience.
 */
export const findTicketById = async (id) => {
  const { rows } = await query(
    `SELECT t.*,
            c.name AS customer_name, c.email AS customer_email,
            a.name AS agent_name,   a.email AS agent_email
     FROM tickets t
     JOIN users c ON c.id = t.customer_id
     LEFT JOIN users a ON a.id = t.agent_id
     WHERE t.id = $1`,
    [id]
  );
  return rows[0] || null;
};

/**
 * Get a customer's active pending ticket.
 */
export const findPendingTicketByCustomerId = async (customerId) => {
  const { rows } = await query(
    `SELECT * FROM tickets WHERE customer_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  return rows[0] || null;
};

/**
 * List tickets — filterable by status, customer, or agent.
 * Agents see all; customers see only their own.
 */
export const findTickets = async ({ status, customerId, agentId, agentOrPending, limit = 50, offset = 0 } = {}) => {
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`t.status = $${params.length}`);
  }
  if (customerId) {
    params.push(customerId);
    conditions.push(`t.customer_id = $${params.length}`);
  }
  if (agentId) {
    params.push(agentId);
    conditions.push(`t.agent_id = $${params.length}`);
  }
  if (agentOrPending) {
    params.push(agentOrPending);
    conditions.push(`(t.status = 'pending' OR t.agent_id = $${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT t.*,
            c.name AS customer_name,
            a.name AS agent_name
     FROM tickets t
     JOIN users c ON c.id = t.customer_id
     LEFT JOIN users a ON a.id = t.agent_id
     ${where}
     ORDER BY t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
};

/**
 * Assign a ticket to an agent (used by matching service in M3).
 */
export const assignTicket = async (ticketId, agentId) => {
  const { rows, rowCount } = await query(
    `UPDATE tickets
     SET agent_id = $2, status = 'assigned', assigned_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'open')
     RETURNING *`,
    [ticketId, agentId]
  );
  if (rowCount === 0) {
    throw new ConcurrencyError(`Cannot assign ticket ${ticketId}: ticket is no longer pending/open.`);
  }
  return rows[0];
};

/**
 * Unassign a ticket (used when agent disconnects).
 */
export const unassignTicket = async (ticketId) => {
  const { rows, rowCount } = await query(
    `UPDATE tickets
     SET status = 'pending', agent_id = NULL
     WHERE id = $1 AND status != 'closed'
     RETURNING *`,
    [ticketId]
  );
  if (rowCount === 0) {
    throw new ConcurrencyError(`Cannot unassign ticket ${ticketId}: ticket is already closed or modified.`);
  }
  return rows[0];
};

/**
 * Close a ticket and record closed_at timestamp.
 */
export const closeTicket = async (ticketId) => {
  // M9: Ensure all remaining buffered chat messages are flushed to the DB before closing
  try {
    const { forceFlushTranscript } = await import('../workers/transcriptWorker.js');
    await forceFlushTranscript(ticketId);
  } catch (err) {
    console.error('[Ticket Model] Error force-flushing transcript on close:', err.message);
  }

  const { rows, rowCount } = await query(
    `UPDATE tickets
     SET status = 'closed', closed_at = NOW()
     WHERE id = $1 AND status != 'closed'
     RETURNING *`,
    [ticketId]
  );
  
  if (rowCount === 0) {
    throw new ConcurrencyError(`Cannot close ticket ${ticketId}: already closed.`);
  }
  
  const ticket = rows[0];

  if (ticket) {
    // M11.T2: Update rolling average handle time
    if (ticket.assigned_at && ticket.closed_at) {
      const durationMs = new Date(ticket.closed_at).getTime() - new Date(ticket.assigned_at).getTime();
      try {
        const { updateAvgHandleTime } = await import('../services/matchingService.js');
        await updateAvgHandleTime(durationMs);
      } catch (err) {
        console.error('[Ticket Model] Error updating avg handle time:', err.message);
      }
    }
    // Send email notification using NotificationService (which checks preferences)
    try {
      const { sendTicketClosed } = await import('../services/notificationService.js');
      await sendTicketClosed(ticketId);
    } catch (err) {
      console.error('[Ticket Model] Error enqueuing close notification:', err.message);
    }
  }

  return ticket;
};

/**
 * Override ticket priority — agents and admins only.
 * 'urgent' can only be set this way (never by customer inference).
 */
export const setTicketPriority = async (ticketId, priority) => {
  const { rows } = await query(
    `UPDATE tickets SET priority = $2 WHERE id = $1 RETURNING *`,
    [ticketId, priority]
  );
  return rows[0];
};

/**
 * Find all tickets past SLA deadline that are still pending/assigned.
 * Used by the SLA escalation worker (M8).
 */
export const findSlaBreachedTickets = async () => {
  const { rows } = await query(
    `SELECT * FROM tickets
     WHERE status IN ('pending', 'assigned')
       AND sla_deadline < NOW()`
  );
  return rows;
};

/**
 * Put a ticket on hold (status 'open').
 * This is used for async/long-running tickets so they don't consume agent live capacity.
 */
export const putTicketOnHold = async (ticketId) => {
  const { rows, rowCount } = await query(
    `UPDATE tickets
     SET status = 'open', updated_at = NOW(), waiting_on_customer = false
     WHERE id = $1 AND status = 'assigned'
     RETURNING *`,
    [ticketId]
  );
  if (rowCount === 0) {
    throw new ConcurrencyError(`Cannot put ticket ${ticketId} on hold: it is no longer assigned.`);
  }
  return rows[0];
};

/**
 * Put an inactive ticket on hold (autoCloseWorker sweep - Phase 1).
 * Specifically requires the ticket to have been inactive for >30m.
 */
export const autoHoldTicket = async (ticketId) => {
  const { rows, rowCount } = await query(
    `UPDATE tickets
     SET status = 'open', waiting_on_customer = true
     WHERE id = $1 
       AND status = 'assigned' 
       AND updated_at < NOW() - INTERVAL '30 minutes'
     RETURNING *`,
    [ticketId]
  );
  
  if (rowCount === 0) {
    throw new ConcurrencyError(`autoHoldTicket skipped ${ticketId}: ticket became active or was modified.`);
  }
  return rows[0];
};

/**
 * Close a stale ticket (autoCloseWorker sweep - Phase 2).
 * Specifically requires the ticket to have been on hold/waiting_on_customer for >24h.
 */
export const autoCloseStaleTicket = async (ticketId) => {
  const { rows, rowCount } = await query(
    `UPDATE tickets
     SET status = 'closed', closed_at = NOW()
     WHERE id = $1 
       AND status = 'open' 
       AND waiting_on_customer = true
       AND updated_at < NOW() - INTERVAL '24 hours'
     RETURNING *`,
    [ticketId]
  );
  
  if (rowCount === 0) {
    throw new ConcurrencyError(`autoCloseStaleTicket skipped ${ticketId}: ticket became active or was modified.`);
  }
  return rows[0];
};
