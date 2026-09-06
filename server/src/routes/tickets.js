/**
 * Ticket routes — M2.T2
 *
 * POST   /api/tickets                — customer creates ticket
 * GET    /api/tickets                — list tickets (agent/admin: all; customer: own)
 * GET    /api/tickets/:id            — get ticket + messages (assigned agent or admin)
 * PATCH  /api/tickets/:id/close      — close ticket (assigned agent or admin)
 */
import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { createError } from '../middleware/errorHandler.js';
import { inferPriority } from '../middleware/inferPriority.js';
import {
  createTicket,
  findTicketById,
  findTickets,
  closeTicket,
  setTicketPriority,
  putTicketOnHold
} from '../models/ticket.js';
import { findMessagesByTicket } from '../models/message.js';
import { matchOrEnqueue } from '../services/matchingService.js';
import { claimTicket, releaseAgent } from '../services/claimService.js';
import { getIo } from '../socket/index.js';

const router = Router();

// All ticket routes require authentication
router.use(authenticateToken);

// ── POST /api/tickets ─────────────────────────────────────────────────────────
// Customer submits a new ticket.
// inferPriority middleware scores priority — customer cannot set it.
router.post('/', requireRole('customer'), inferPriority, async (req, res, next) => {
  try {
    const { subject } = req.body;
    const ticket = await createTicket({
      customerId: req.user.id,
      subject: subject?.trim() || 'Support Request',
      priority: req.inferredPriority,   // set by middleware, not client
    });

    // Trigger matching: instant agent assign or queue entry
    const matchResult = await matchOrEnqueue(req.user.id, ticket.id);

    res.status(201).json({ success: true, ticket, match: matchResult });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tickets ──────────────────────────────────────────────────────────
// Agents/admins see all tickets (filtered by status query param).
// Customers see only their own tickets.
router.get('/', async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const { id, role } = req.user;

    const filter = {
      limit: Math.min(parseInt(limit, 10) || 50, 100),
      offset: parseInt(offset, 10) || 0,
    };

    if (role === 'customer') {
      filter.customerId = id;
      if (status) filter.status = status;
    } else if (role === 'agent') {
      if (status === 'pending' || !status) {
        // pending tickets are unclaimed by definition — every agent can see them
        // combined with "assigned to me" for any other bucket in the default view
        filter.agentOrPending = id;
        if (status) filter.status = status; // narrows to just pending when explicitly requested
      } else {
        // assigned / escalated / closed — scope strictly to this agent's own tickets
        filter.status = status;
        filter.agentId = id;
      }
    } else if (role === 'admin') {
      if (status) filter.status = status; // admin sees everything, filtered by status only
    }

    const tickets = await findTickets(filter);
    res.json({ success: true, tickets });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tickets/:id ──────────────────────────────────────────────────────
// Returns ticket detail + message history.
// Authorization: customer who owns it, assigned agent, or admin.
router.get('/:id', async (req, res, next) => {
  try {
    const ticket = await findTicketById(req.params.id);
    if (!ticket) return next(createError(404, 'Ticket not found'));

    const { id, role } = req.user;
    const isOwner    = ticket.customer_id === id;
    const isAssigned = ticket.agent_id === id;
    const isAdmin    = role === 'admin';

    if (!isOwner && !isAssigned && !isAdmin) {
      return next(createError(403, 'Access denied'));
    }

    // Fetch persisted message history (Redis buffer merged in M6)
    const messages = await findMessagesByTicket(ticket.id);

    res.json({ success: true, ticket, messages });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/tickets/:id/hold ──────────────────────────────────────────────
// Put a ticket on hold. Only the assigned agent or admin can do this.
router.patch('/:id/hold', requireRole('agent', 'admin'), async (req, res, next) => {
  try {
    const ticket = await findTicketById(req.params.id);
    if (!ticket) return next(createError(404, 'Ticket not found'));

    if (ticket.status !== 'assigned') {
      return next(createError(409, 'Only currently assigned tickets can be put on hold'));
    }

    const { id, role } = req.user;
    if (role !== 'admin' && ticket.agent_id !== id) {
      return next(createError(403, 'Only the assigned agent or admin can put this ticket on hold'));
    }

    let held;
    try {
      held = await putTicketOnHold(ticket.id);
    } catch (err) {
      if (err.name === 'ConcurrencyError') {
        return next(createError(409, 'Ticket state changed before hold could complete.'));
      }
      throw err;
    }

    // Release agent's live capacity slot
    if (ticket.agent_id) {
      await releaseAgent(ticket.agent_id, ticket.id);
    }

    const io = getIo();
    io.to(`ticket:${ticket.id}`).emit('ticket:on_hold', { ticketId: ticket.id });

    res.json({ success: true, ticket: held });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/tickets/:id/close ──────────────────────────────────────────────
// Close a ticket. Only the assigned agent or admin can close.
router.patch('/:id/close', requireRole('agent', 'admin'), async (req, res, next) => {
  try {
    const ticket = await findTicketById(req.params.id);
    if (!ticket) return next(createError(404, 'Ticket not found'));

    if (ticket.status === 'closed') {
      return next(createError(409, 'Ticket is already closed'));
    }

    const { id, role } = req.user;
    if (role !== 'admin' && ticket.agent_id !== id) {
      return next(createError(403, 'Only the assigned agent or admin can close this ticket'));
    }

    let closed;
    try {
      closed = await closeTicket(ticket.id);
    } catch (err) {
      if (err.name === 'ConcurrencyError') {
        return next(createError(409, 'Ticket was closed by another process'));
      }
      throw err;
    }

    // Release agent — serve next queued customer or mark available
    if (ticket.agent_id) {
      await releaseAgent(ticket.agent_id, ticket.id);
    } else {
      const { removeFromQueue } = await import('../services/matchingService.js');
      await removeFromQueue(ticket.customer_id);
    }

    // Notify both sides
    try {
      const { emitTicketClosed } = await import('../socket/index.js');
      emitTicketClosed(ticket.id);
    } catch (_) { /* socket optional */ }

    res.json({ success: true, ticket: closed });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tickets/:id/claim ────────────────────────────────────────────────
// Agent claims a pending ticket. Uses Redis SET NX EX distributed lock
// to prevent two agents claiming simultaneously.
router.post('/:id/claim', requireRole('agent'), async (req, res, next) => {
  try {
    const result = await claimTicket(req.params.id, req.user.id);

    if (!result.success) {
      const statusMap = {
        agent_offline:   [403, 'You must be online to claim tickets'],
        ticket_limit_reached: [429, 'You have reached the maximum number of active tickets'],
        ticket_locked:   [409, 'Another agent is claiming this ticket'],
        already_claimed: [409, `Ticket already ${result.currentStatus || 'claimed'}`],
        not_found:       [404, 'Ticket not found'],
      };
      const [status, message] = statusMap[result.reason] || [400, 'Could not claim ticket'];
      return next(createError(status, message));
    }

    // Notify customer via WebSocket that they've been matched
    try {
      const { getIo, emitTicketMatched } = await import('../socket/index.js');
      const { findUserById } = await import('../models/user.js');
      const agent = await findUserById(req.user.id);
      emitTicketMatched(result.ticket.customer_id, result.ticket.id, req.user.id, agent?.name || 'Agent');
      const { sendTicketAssigned } = await import('../services/notificationService.js');
      await sendTicketAssigned(result.ticket.id);
    } catch (_) { /* socket/notification optional */ }

    res.json({ success: true, ticket: result.ticket });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/tickets/:id/priority ───────────────────────────────────────────────
// Agents and admins can override priority (including setting 'urgent').
// Customers never touch priority — it's inferred by the system at creation time.
router.patch('/:id/priority', requireRole('agent', 'admin'), async (req, res, next) => {
  try {
    const { priority } = req.body;
    const VALID = ['low', 'normal', 'high', 'urgent'];
    if (!VALID.includes(priority)) {
      return next(createError(400, `priority must be one of: ${VALID.join(', ')}`));
    }

    const ticket = await findTicketById(req.params.id);
    if (!ticket) return next(createError(404, 'Ticket not found'));

    if (ticket.status === 'closed') {
      return next(createError(409, 'Cannot reprioritise a closed ticket'));
    }

    // Agents can only reprioritise tickets assigned to them; admins can do any
    if (req.user.role !== 'admin' && ticket.agent_id !== req.user.id) {
      return next(createError(403, 'Only the assigned agent or admin can change priority'));
    }

    const updated = await setTicketPriority(ticket.id, priority);
    res.json({ success: true, ticket: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
