import { Queue, Worker } from 'bullmq';
import { createRedisClient } from '../config/redis.js';
import { query } from '../config/db.js';
import { getIo } from '../socket/index.js';

const connection = createRedisClient();

export const reminderQueue = new Queue('reminders', { connection });

export const reminderWorker = new Worker('reminders', async (job) => {
  if (job.name === 'daily-reminders') {
    console.log('[Worker] Running daily-reminders cron job...');
    try {
      // For testing: we are looking for 'open' tickets that haven't been updated in the last 1 minute.
      // In production, this would be 24 hours: NOW() - INTERVAL '24 hours'
      const { rows: staleTickets } = await query(
        `SELECT id, agent_id, subject, updated_at 
         FROM tickets 
         WHERE status = 'open' 
           AND agent_id IS NOT NULL
           AND updated_at < NOW() - INTERVAL '1 minute'`
      );

      if (staleTickets.length === 0) return;

      const io = getIo();
      
      for (const ticket of staleTickets) {
        console.log(`[Worker] Sending reminder to agent ${ticket.agent_id} for stale ticket ${ticket.id}`);
        // Send a notification event to the agent's private room
        io.to(`agent:${ticket.agent_id}`).emit('agent:notification', {
          id: `notif-${Date.now()}-${ticket.id}`,
          ticketId: ticket.id,
          subject: ticket.subject,
          message: `Ticket "${ticket.subject}" has been on-hold for a while.`,
          timestamp: new Date().toISOString()
        });
        await query(`UPDATE tickets SET updated_at = NOW() WHERE id = $1`, [ticket.id]);
      }
    } catch (err) {
      console.error('[Worker] Error running daily-reminders:', err);
    }
  }
}, { connection });

const IS_SCHEDULER = process.env.PORT === '3001';

if (IS_SCHEDULER) {
  // Schedule the repeatable cron job
  // For testing, we run it every minute (* * * * *). In prod: 0 9 * * * (9 AM daily)
  reminderQueue.add('daily-reminders', {}, {
    repeat: {
      pattern: '* * * * *'
    },
    jobId: 'daily-reminders-cron'
  });
}

reminderWorker.on('failed', (job, err) => {
  console.error(`[Worker] Reminder job failed:`, err.message);
});
