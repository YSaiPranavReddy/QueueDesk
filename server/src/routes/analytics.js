import { Router } from 'express';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { getDashboardMetrics } from '../models/analytics.js';

const router = Router();

router.use(authenticateToken);
router.use(requireRole('admin'));

/**
 * @swagger
 * /api/analytics:
 *   get:
 *     summary: Get dashboard analytics metrics
 *     description: Returns aggregated system metrics and agent performance. Only accessible by admins.
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard metrics
 *       403:
 *         description: Access denied (Admins only)
 */
router.get('/', async (req, res, next) => {
  try {
    const metrics = await getDashboardMetrics();
    
    // In M3 we integrated Redis for live agent online statuses. 
    // We can merge that live status into our agent performance array here.
    try {
      const { getAgentStatusMap } = await import('../services/matchingService.js');
      const agentIds = metrics.agents.map(a => a.id);
      if (agentIds.length > 0) {
        const statusMap = await getAgentStatusMap(agentIds);
        metrics.agents = metrics.agents.map(a => ({
          ...a,
          online_status: statusMap[a.id] || 'offline'
        }));
      }
    } catch (e) {
      // If Redis isn't connected or service fails, default to offline
      metrics.agents = metrics.agents.map(a => ({ ...a, online_status: 'offline' }));
    }

    res.json({ success: true, metrics });
  } catch (err) {
    next(err);
  }
});

export default router;
