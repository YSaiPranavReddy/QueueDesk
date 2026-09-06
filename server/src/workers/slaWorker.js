import { Queue, Worker } from 'bullmq';
import { createRedisClient } from '../config/redis.js';
import { query } from '../config/db.js';
import { getIo } from '../socket/index.js';
import { logger } from '../utils/logger.js';
import { slaEscalationsTotal } from '../utils/metrics.js';

const connection = createRedisClient();

export const slaQueue = new Queue('sla-escalation', { connection });

export const slaWorker = new Worker('sla-escalation', async (job) => {
  if (job.name === 'sla-check') {
    logger.info('[Worker] Running sla-check cron job...');
    try {
      // Find tickets that breached SLA and are not already high/urgent priority
      const { rows: staleTickets } = await query(
        `SELECT id, subject, customer_id
         FROM tickets 
         WHERE status = 'pending' 
           AND sla_deadline < NOW() 
           AND priority IN ('low', 'normal')`
      );

      if (staleTickets.length === 0) return;
      
      const { routePendingTicket } = await import('../services/claimService.js');

      for (const ticket of staleTickets) {
        // Atomic bump: if it's still pending, set priority to 'high'
        const { rowCount } = await query(
          `UPDATE tickets 
           SET priority = 'high' 
           WHERE id = $1 AND status = 'pending' 
           RETURNING *`, 
          [ticket.id]
        );

        if (rowCount > 0) {
          logger.info({ ticketId: ticket.id }, `[Worker] Escalating ticket due to SLA breach.`);
          slaEscalationsTotal.inc();
          
          // Recirculate: puts it at the front of the queue using our priority scoring
          const matchResult = await routePendingTicket(ticket);

          // Only send the breach email if it wasn't instantly assigned to an idle agent
          if (!matchResult?.matched) {
            const { sendTicketEscalated } = await import('../services/notificationService.js');
            await sendTicketEscalated(ticket.id);
          }
        }
      }

      // No longer firing emailJobs here, they are dispatched internally by sendTicketEscalated
    } catch (err) {
      logger.error({ err }, '[Worker] Error running sla-check');
    }
  }
}, { connection });

const IS_SCHEDULER = process.env.PORT === '3001';

if (IS_SCHEDULER) {
  // Schedule the repeatable cron job
  // Runs every minute to sweep for breached SLAs
  slaQueue.add('sla-check', {}, {
    repeat: {
      pattern: '* * * * *'
    },
    jobId: 'sla-check-cron'
  });
}

slaWorker.on('failed', (job, err) => {
  logger.error({ err }, `[Worker] SLA job failed`);
});
