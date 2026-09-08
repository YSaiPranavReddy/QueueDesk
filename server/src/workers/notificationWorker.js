import { Queue, Worker } from 'bullmq';
import { Resend } from 'resend';
import { createRedisClient } from '../config/redis.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { notificationDeadLetterTotal, emailDeliveryLatencySeconds } from '../utils/metrics.js';

const connection = createRedisClient();

export const notificationQueue = new Queue('notifications', { connection });

// Resend client — initialised once, reused for all email sends
const resend = new Resend(config.email.resendApiKey);

export const notificationWorker = new Worker('notifications', async (job) => {
  if (job.name === 'email') {
    const endTimer = emailDeliveryLatencySeconds.startTimer();
    const { to, subject, html, text } = job.data;

    logger.info({ to, subject }, `[Worker] Sending email via Resend`);

    const { data, error } = await resend.emails.send({
      from: config.email.from,   // e.g. "QueueDesk <onboarding@resend.dev>"
      to,
      subject,
      html,
      text,
    });

    if (error) {
      // Throw so BullMQ treats it as a failed job and retries
      throw new Error(`Resend error: ${error.message}`);
    }

    logger.info({ emailId: data?.id, to, subject }, `[Worker] Email delivered via Resend`);
    endTimer();
  }
}, { connection });

notificationWorker.on('failed', async (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    logger.error({ err, jobId: job.id, attempts: job.attemptsMade }, `[DEAD LETTER] Notification job failed permanently`);
    notificationDeadLetterTotal.inc();

    // Log permanently failed notifications to DB (forensic tracking)
    try {
      const { query } = await import('../config/db.js');
      await query(
        `INSERT INTO notification_log (user_id, ticket_id, channel, event_type, status, attempts, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          job.data.userId || null,
          job.data.ticketId || null,
          'email',
          job.data.eventType || 'unknown',
          'failed',
          job.attemptsMade,
          err.message
        ]
      );
    } catch (dbErr) {
      logger.error({ err: dbErr }, `[DEAD LETTER DB] Failed to write to notification_log`);
    }
  } else {
    logger.warn({ err, jobId: job.id, attempts: job.attemptsMade }, `[Worker] Notification job failed, will retry`);
  }
});

