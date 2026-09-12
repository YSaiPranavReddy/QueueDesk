import { Queue, Worker } from 'bullmq';
import { createRedisClient } from '../config/redis.js';
import { releaseAgent } from '../services/claimService.js';
import { findTicketById, findTickets, putTicketOnHold } from '../models/ticket.js';
import { markAgentOffline } from '../services/matchingService.js';
import { logger } from '../utils/logger.js';

const connection = createRedisClient();

export const disconnectQueue = new Queue('disconnects', { connection });

export const disconnectWorker = new Worker('disconnects', async (job) => {
  const { type, userId, ticketId } = job.data;

  if (type === 'customer-abandon') {
    logger.info({ ticketId, userId }, `[Worker] Processing customer-abandon`);
    try {
      const ticket = await findTicketById(ticketId);
      if (ticket?.status !== 'assigned') return;

      const { getIo } = await import('../socket/index.js');
      const socketIo = getIo();
      const customerSockets = await socketIo.in(`customer:${userId}`).fetchSockets();
      
      if (customerSockets.length === 0) {
        logger.info({ ticketId, userId }, `[Worker] Customer abandoned ticket. Putting on hold, freeing agent.`);
        await putTicketOnHold(ticketId);
        socketIo.to(`ticket:${ticketId}`).emit('ticket:on_hold', { ticketId });
        await releaseAgent(ticket.agent_id, ticketId);
      } else {
        logger.info({ ticketId, userId }, `[Worker] Customer reconnected before timeout. Ignoring abandon.`);
      }
    } catch (err) {
      logger.error({ err, ticketId, userId }, '[Worker] Error processing customer-abandon');
    }
  } else if (type === 'agent-disconnect') {
    logger.info({ userId }, `[Worker] Processing agent-disconnect`);
    try {
      const { getIo } = await import('../socket/index.js');
      const socketIo = getIo();
      
      const agentSockets = await socketIo.in(`agent:${userId}`).fetchSockets();
      if (agentSockets.length === 0) {
        logger.info({ userId }, `[Worker] Agent disconnect grace period expired.`);
        await markAgentOffline(userId);
        
        // 1. Currently-assigned tickets
        const { findTickets, findPendingTicketByCustomerId } = await import('../models/ticket.js');
        const { recirculateTicket } = await import('../services/claimService.js');
        const assignedTickets = await findTickets({ agentId: userId, status: "assigned" });
        
        for (const t of assignedTickets) {
          logger.info({ ticketId: t.id, userId }, `[Worker] Recirculating ticket from offline agent`);
          await recirculateTicket(t.id);
        }

        // 2. On-hold tickets
        const onHoldTickets = await findTickets({ agentId: userId, status: "open" });
        for (const t of onHoldTickets) {
          logger.info({ ticketId: t.id, userId }, `[Worker] Agent gone — recirculating orphaned on-hold ticket`);
          await recirculateTicket(t.id);
        }

        // 3. Drain stranded sticky queue
        const stickyKey = `queue:sticky:${userId}`;
        const stranded = await connection.zrange(stickyKey, 0, -1);
        for (const customerId of stranded) {
          await connection.zrem(stickyKey, customerId);
          let strandedTicket = await findPendingTicketByCustomerId(customerId);
          if (!strandedTicket) {
             const openTickets = await findTickets({ customerId, status: 'open' });
             strandedTicket = openTickets[0];
          }
          if (strandedTicket) {
            logger.info({ ticketId: strandedTicket.id, customerId, userId }, `[Worker] Recirculating stranded ticket from sticky queue`);
            await recirculateTicket(strandedTicket.id);
          }
        }
      }
    } catch (err) {
      logger.error({ err, userId }, '[Worker] Error processing agent-disconnect');
    }
  }
}, { connection });

disconnectWorker.on('failed', (job, err) => {
  logger.error({ err, jobId: job?.id }, `[Worker] Disconnect job failed`);
});

