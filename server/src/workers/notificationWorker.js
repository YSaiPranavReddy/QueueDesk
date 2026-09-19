import { Queue, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { createRedisClient } from '../config/redis.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { notificationDeadLetterTotal, emailDeliveryLatencySeconds } from '../utils/metrics.js';

const connection = createRedisClient();

export const notificationQueue = new Queue('notifications', { connection });

// Nodemailer transport
const transporter = nodemailer.createTransport({
  host: config.email.smtpHost,
  port: config.email.smtpPort,
  secure: config.email.smtpPort === 465, // true for 465, false for other ports
  auth: {
    user: config.email.smtpUser,
    pass: config.email.smtpPass,
  },
});

export const notificationWorker = new Worker('notifications', async (job) => {
  if (job.name === 'email') {
    const endTimer = emailDeliveryLatencySeconds.startTimer();
    const { to, subject, html, text } = job.data;

    logger.info({ to, subject }, `[Worker] Sending email via SMTP`);

    try {
      const info = await transporter.sendMail({
        from: config.email.from,
        to,
        subject,
        html,
        text,
      });

      logger.info({ messageId: info.messageId, to, subject }, `[Worker] Email delivered via SMTP`);
    } catch (error) {
      // Throw so BullMQ treats it as a failed job and retries
      throw new Error(`SMTP error: ${error.message}`);
    }

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

