/**
 * Messages routes — M2.T3
 *
 * GET /api/tickets/:id/messages — fetch persisted message history for a ticket.
 * Used on client reconnect to catch up on missed messages (REST, not WebSocket).
 * Live messages arrive via WebSocket in M6.
 */
import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { createError } from '../middleware/errorHandler.js';
import { findTicketById } from '../models/ticket.js';
import { findMessagesByTicket } from '../models/message.js';

const router = Router({ mergeParams: true }); // inherit :id from parent

router.use(authenticateToken);

// GET /api/tickets/:id/messages
router.get('/', async (req, res, next) => {
  try {
    const ticket = await findTicketById(req.params.id);
    if (!ticket) return next(createError(404, 'Ticket not found'));

    // Same auth check as GET /tickets/:id
    const { id, role } = req.user;
    const isOwner    = ticket.customer_id === id;
    const isAssigned = ticket.agent_id === id;
    const isAdmin    = role === 'admin';

    if (!isOwner && !isAssigned && !isAdmin) {
      return next(createError(403, 'Access denied'));
    }

    const { limit, before } = req.query;
    const messages = await findMessagesByTicket(ticket.id, {
      limit: Math.min(parseInt(limit, 10) || 100, 200),
      before: before || null,
    });

    res.json({ success: true, messages });
  } catch (err) {
    next(err);
  }
});

export default router;
