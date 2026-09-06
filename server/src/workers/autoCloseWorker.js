import { Queue, Worker } from 'bullmq';
import { createRedisClient } from '../config/redis.js';
import redis from '../config/redis.js';
import { query } from '../config/db.js';
import { closeTicket } from '../models/ticket.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { ticketsAutoClosedTotal } from '../utils/metrics.js';

const connection = createRedisClient();

export const autoCloseQueue = new Queue('auto-close', { connection });

const CLOSE_MINUTES = config.sla.autoCloseMinutes;

export const autoCloseWorker = new Worker('auto-close', async (job) => {
  if (job.name === 'auto-close-check') {
    try {
      const { getIo } = await import('../socket/index.js');
      const io = getIo();
      const { v4: uuidv4 } = await import('uuid');

      // --- Phase 1: Auto-Hold ---
      // Find assigned tickets inactive for >30 minutes where waiting_on_customer is false
      const { rows: phase1Tickets } = await query(
        `SELECT id, customer_id, agent_id
         FROM tickets 
         WHERE status = 'assigned' 
           AND updated_at < NOW() - INTERVAL '30 minutes'`
      );

      for (const ticket of phase1Tickets) {
        logger.info({ ticketId: ticket.id }, `[Worker] Ticket inactive for >30m. Auto-holding.`);
        
        // Use the proper claimService/ticket pattern to maintain sticky routing and capacity
        const { autoHoldTicket } = await import('../models/ticket.js');
        const { releaseAgent } = await import('../services/claimService.js');
        
        try {
          await autoHoldTicket(ticket.id);
        } catch (err) {
          if (err.name === 'ConcurrencyError') {
            logger.warn({ ticketId: ticket.id }, `[Worker] Ticket became active before auto-hold could complete. Skipping.`);
            continue; // Skip this ticket and move to the next one
          }
          throw err;
        }

        await releaseAgent(ticket.agent_id, ticket.id);
        
        const warningMsg = {
          id: uuidv4(),
          ticket_id: ticket.id,
          sender_id: 'system',
          sender_role: 'system',
          body: `This ticket has been placed on hold due to inactivity. It will automatically close in 24 hours if there is no response.`,
          created_at: new Date().toISOString()
        };

        const { insertMessage } = await import('../models/message.js');
        await insertMessage(warningMsg);
        
        // Notify clients
        io.to(`ticket:${ticket.id}`).emit('chat:message', { message: warningMsg });
        io.to(`ticket:${ticket.id}`).emit('ticket:on_hold', { ticketId: ticket.id });
      }

      // --- Phase 2: Auto-Close ---
      // Find open tickets where waiting_on_customer is true inactive for >24 hours
      const { rows: phase2Tickets } = await query(
        `SELECT id
         FROM tickets 
         WHERE status = 'open' 
           AND waiting_on_customer = true
           AND updated_at < NOW() - INTERVAL '24 hours'`
      );

      for (const ticket of phase2Tickets) {
        logger.info({ ticketId: ticket.id }, `[Worker] Ticket on auto-hold for >24h. Auto-closing.`);
        const { autoCloseStaleTicket } = await import('../models/ticket.js');
        
        try {
          await autoCloseStaleTicket(ticket.id);
          ticketsAutoClosedTotal.inc();
        } catch (err) {
          if (err.name === 'ConcurrencyError') {
            logger.warn({ ticketId: ticket.id }, `[Worker] Ticket became active before auto-close could complete. Skipping.`);
            continue;
          }
          throw err;
        }
        const { sendTicketClosed } = await import('../services/notificationService.js');
        await sendTicketClosed(ticket.id);

        io.to(`ticket:${ticket.id}`).emit('ticket:closed', { ticketId: ticket.id });
      }

    } catch (err) {
      logger.error({ err }, '[Worker] Error running auto-close-check');
    }
  }
}, { connection });

const IS_SCHEDULER = process.env.PORT === '3001';

if (IS_SCHEDULER) {
  autoCloseQueue.add('auto-close-check', {}, {
    repeat: {
      pattern: '* * * * *' // Every minute
    },
    jobId: 'auto-close-cron'
  });
}

autoCloseWorker.on('failed', (job, err) => {
  logger.error({ err }, `[Worker] Auto-close job failed`);
});
