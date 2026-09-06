import { Queue, Worker } from 'bullmq';
import { createRedisClient } from '../config/redis.js';
import { releaseAgent } from '../services/claimService.js';
import { findTicketById, findTickets, putTicketOnHold } from '../models/ticket.js';
import { markAgentOffline } from '../services/matchingService.js';

const connection = createRedisClient();

export const disconnectQueue = new Queue('disconnects', { connection });

export const disconnectWorker = new Worker('disconnects', async (job) => {
  const { type, userId, ticketId } = job.data;

  if (type === 'customer-abandon') {
    console.log(`[Worker] Processing customer-abandon for ticket ${ticketId}`);
    try {
      const ticket = await findTicketById(ticketId);
      if (ticket?.status !== 'assigned') return;

      const { getIo } = await import('../socket/index.js');
      const socketIo = getIo();
      const customerSockets = await socketIo.in(`customer:${userId}`).fetchSockets();
      
      if (customerSockets.length === 0) {
        console.log(`[Worker] Customer ${userId} abandoned ticket ${ticketId}. Putting ticket on hold and freeing agent.`);
        await putTicketOnHold(ticketId);
        socketIo.to(`ticket:${ticketId}`).emit('ticket:on_hold', { ticketId });
        await releaseAgent(ticket.agent_id, ticketId);
      } else {
        console.log(`[Worker] Customer ${userId} reconnected to ticket ${ticketId} before timeout. Ignoring abandon.`);
      }
    } catch (err) {
      console.error('[Worker] Error processing customer-abandon:', err);
    }
  } else if (type === 'agent-disconnect') {
    console.log(`[Worker] Processing agent-disconnect for agent ${userId}`);
    try {
      const { getIo } = await import('../socket/index.js');
      const socketIo = getIo();
      
      const agentSockets = await socketIo.in(`agent:${userId}`).fetchSockets();
      if (agentSockets.length === 0) {
        console.log(`[Worker] Agent ${userId} disconnect grace period expired.`);
        await markAgentOffline(userId);
        
        // 1. Currently-assigned tickets
        const { findTickets, findPendingTicketByCustomerId } = await import('../models/ticket.js');
        const { recirculateTicket } = await import('../services/claimService.js');
        const assignedTickets = await findTickets({ agentId: userId, status: "assigned" });
        
        for (const t of assignedTickets) {
          console.log(`[Worker] Recirculating ticket ${t.id} from offline agent ${userId}`);
          await recirculateTicket(t.id);
        }

        // 2. On-hold tickets
        const onHoldTickets = await findTickets({ agentId: userId, status: "open" });
        for (const t of onHoldTickets) {
          console.log(`[Worker] Agent ${userId} gone — recirculating orphaned on-hold ticket ${t.id}`);
          await recirculateTicket(t.id);
        }

        // 3. Drain stranded sticky queue
        const stickyKey = `queue:sticky:${userId}`;
        const stranded = await connection.zrange(stickyKey, 0, -1);
        for (const customerId of stranded) {
          await connection.zrem(stickyKey, customerId);
          // find stranded ticket
          let strandedTicket = await findPendingTicketByCustomerId(customerId);
          if (!strandedTicket) {
             const openTickets = await findTickets({ customerId, status: 'open' });
             strandedTicket = openTickets[0];
          }
          if (strandedTicket) {
            console.log(`[Worker] Recirculating stranded ticket ${strandedTicket.id} from sticky queue ${userId}`);
            await recirculateTicket(strandedTicket.id);
          }
        }
      }
    } catch (err) {
      console.error('[Worker] Error processing agent-disconnect:', err);
    }
  }
}, { connection });

disconnectWorker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id} has failed with ${err.message}`);
});
