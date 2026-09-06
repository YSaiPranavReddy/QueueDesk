/**
 * Agents routes — M2.T4
 *
 * PATCH /api/agents/status         — agent sets own status (available/busy/offline)
 * GET   /api/agents                — admin: list all agents with DB info
 *                                    (Redis online status merged in M3 when Redis is live)
 */
import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { createError } from '../middleware/errorHandler.js';
import { findAllAgents, findUserById } from '../models/user.js';
import {
  markAgentAvailable,
  markAgentOffline,
  getAgentStatusMap,
} from '../services/matchingService.js';
import { assignNextInQueue } from '../services/claimService.js';

const router = Router();

router.use(authenticateToken);

const VALID_STATUSES = ['available', 'busy', 'offline'];

// ── PATCH /api/agents/status ──────────────────────────────────────────────────
// Agent updates their own availability.
// Writes to Redis in M3 (here we just validate and return the value — Redis not yet live).
router.patch('/status', requireRole('agent', 'admin'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status)) {
      return next(createError(400, `status must be one of: ${VALID_STATUSES.join(', ')}`));
    }

    let matchResult = null;
    if (status === 'available') {
      const { findTickets } = await import('../models/ticket.js');
      const active = await findTickets({ agentId: req.user.id, status: 'assigned' });
      if (active.length >= 5) {
        return next(createError(429, 'You are at your active ticket limit — close a ticket before going available'));
      }

      matchResult = await markAgentAvailable(req.user.id);
      
      // If we instantly served someone from the queue, assign the ticket!
      if (matchResult.served) {
        await assignNextInQueue(req.user.id, matchResult.customerId);
      }
    } else {
      await markAgentOffline(req.user.id);
      // For 'busy', just set the hash — busy is set by the matching service automatically
      if (status === 'busy') {
        const { default: redis } = await import('../config/redis.js');
        const multi = redis.multi();
        multi.hset(`agent:status:${req.user.id}`, 'status', 'busy');
        multi.expire(`agent:status:${req.user.id}`, 120); // M11.T1: TTL
        await multi.exec();
      }
    }

    res.json({
      success: true,
      agentId: req.user.id,
      status,
      ...(matchResult?.served && { immediateCustomer: matchResult.customerId }),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/agents ───────────────────────────────────────────────────────────
// Admin: list all agents. Online status will be merged from Redis in M3.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const agents = await findAllAgents();

    const statusMap = await getAgentStatusMap(agents.map((a) => a.id));
    const agentsWithStatus = agents.map((a) => ({
      ...a,
      status: statusMap[a.id] || 'unknown',
    }));

    res.json({ success: true, agents: agentsWithStatus });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/agents/:id ───────────────────────────────────────────────────────
// Get a specific agent's profile (admin or the agent themselves).
router.get('/:id', requireRole('agent', 'admin'), async (req, res, next) => {
  try {
    const { id, role } = req.user;
    if (role !== 'admin' && req.params.id !== id) {
      return next(createError(403, 'Agents can only view their own profile'));
    }
    const agent = await findUserById(req.params.id);
    if (!agent) return next(createError(404, 'Agent not found'));
    res.json({ success: true, agent });
  } catch (err) {
    next(err);
  }
});

export default router;
