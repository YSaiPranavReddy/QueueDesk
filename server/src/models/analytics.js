import { query } from '../config/db.js';

/**
 * Get aggregated dashboard metrics for admins.
 */
export const getDashboardMetrics = async () => {
  // 1. Global Stats
  const { rows: statsRows } = await query(`
    SELECT 
      COUNT(*) AS total_tickets,
      COUNT(*) FILTER (WHERE status = 'pending') AS pending_tickets,
      COUNT(*) FILTER (WHERE status = 'escalated') AS escalated_tickets,
      COUNT(*) FILTER (WHERE status = 'closed') AS closed_tickets,
      COUNT(*) FILTER (WHERE status = 'assigned') AS active_tickets
    FROM tickets
  `);

  const globalStats = {
    total: parseInt(statsRows[0].total_tickets, 10) || 0,
    pending: parseInt(statsRows[0].pending_tickets, 10) || 0,
    escalated: parseInt(statsRows[0].escalated_tickets, 10) || 0,
    closed: parseInt(statsRows[0].closed_tickets, 10) || 0,
    active: parseInt(statsRows[0].active_tickets, 10) || 0,
  };

  // 2. Agent Performance
  const { rows: agentRows } = await query(`
    SELECT 
      u.id, 
      u.name, 
      u.email,
      COUNT(t.id) FILTER (WHERE t.status IN ('assigned', 'escalated')) AS active_chats,
      COUNT(t.id) FILTER (WHERE t.status = 'closed') AS closed_chats
    FROM users u
    LEFT JOIN tickets t ON t.agent_id = u.id
    WHERE u.role = 'agent'
    GROUP BY u.id, u.name, u.email
    ORDER BY closed_chats DESC
  `);

  const agentPerformance = agentRows.map(row => ({
    id: row.id,
    name: row.name,
    email: row.email,
    active_chats: parseInt(row.active_chats, 10) || 0,
    closed_chats: parseInt(row.closed_chats, 10) || 0,
  }));

  return {
    global: globalStats,
    agents: agentPerformance
  };
};
