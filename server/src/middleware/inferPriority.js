/**
 * inferPriority middleware — M2 hotfix
 *
 * Customers never set ticket priority. The system infers it from context.
 * Only agents and admins can escalate/de-escalate via PATCH /api/tickets/:id/priority.
 *
 * Scoring rules (first match wins, top-down):
 *
 *  'low'    — Customer already has 2+ open tickets (likely already being helped
 *              or flooding the queue)
 *
 *  'high'   — Subject contains known urgency keywords (outage, down, crash…)
 *
 *  'normal' — Everything else (safe default)
 *
 * 'urgent' is intentionally not assignable by this middleware.
 * It is reserved for agent/admin manual escalation or the SLA worker (M8).
 *
 * Attaches req.inferredPriority for the route handler to consume.
 * Strips any priority field the client may have sent.
 */
import { query } from '../config/db.js';

const URGENCY_KEYWORDS = [
  'down', 'outage', 'crash', 'crashed', 'broken', 'critical',
  'not working', 'production', 'emergency', 'urgent', 'blocked',
  'data loss', 'security', 'breach', 'hack',
];

/**
 * Count open (non-closed) tickets for a customer.
 * @param {string} customerId
 * @returns {Promise<number>}
 */
const countOpenTickets = async (customerId) => {
  const { rows } = await query(
    `SELECT COUNT(*) AS cnt
     FROM tickets
     WHERE customer_id = $1
       AND status NOT IN ('closed', 'escalated')`,
    [customerId]
  );
  return parseInt(rows[0].cnt, 10);
};

/**
 * Check if subject contains urgency keywords.
 * @param {string} subject
 * @returns {boolean}
 */
const hasUrgencyKeyword = (subject) => {
  const lower = (subject || '').toLowerCase();
  return URGENCY_KEYWORDS.some((kw) => lower.includes(kw));
};

/**
 * Express middleware — attaches req.inferredPriority.
 * Must be used AFTER authenticateToken (needs req.user.id).
 */
export const inferPriority = async (req, _res, next) => {
  // Strip any priority the client sent — we decide, not them
  delete req.body.priority;

  try {
    const openCount = await countOpenTickets(req.user.id);
    const subject   = req.body.subject || '';

    let priority = 'normal';

    if (openCount >= 2) {
      // Already has multiple open issues — don't let them jump the queue
      priority = 'low';
    } else if (hasUrgencyKeyword(subject)) {
      priority = 'high';
    }

    req.inferredPriority = priority;
    next();
  } catch (err) {
    // Non-fatal: if inference fails, default to normal
    req.inferredPriority = 'normal';
    next();
  }
};
