import { Queue, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { createRedisClient } from '../config/redis.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { notificationDeadLetterTotal, emailDeliveryLatencySeconds } from '../utils/metrics.js';

const connection = createRedisClient();

export const notificationQueue = new Queue('notifications', { connection });

// Configure Nodemailer with Ethereal (or SendGrid in prod)
const transporter = nodemailer.createTransport({
  host: config.email.host,
  port: config.email.port,
  auth: config.email.user ? {
    user: config.email.user,
    pass: config.email.pass,
  } : undefined,
});

export const notificationWorker = new Worker('notifications', async (job) => {
  if (job.name === 'email') {
    const endTimer = emailDeliveryLatencySeconds.startTimer();
    const { to, subject, html, text } = job.data;
    
    logger.info({ to, subject }, `[Worker] Sending email`);
    
    const info = await transporter.sendMail({
      from: config.email.from,
      to,
      subject,
      text,
      html,
    });
    
    if (config.email.host === 'smtp.ethereal.email') {
      logger.info({ url: nodemailer.getTestMessageUrl(info) }, `[Worker] Preview URL generated`);
    }
    
    endTimer();
  }
}, { connection });

notificationWorker.on('failed', async (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    logger.error({ err, jobId: job.id, attempts: job.attemptsMade }, `[DEAD LETTER] Notification job failed permanently`);
    notificationDeadLetterTotal.inc();
    
    // M10.T5: Log permanently failed notifications to DB (Forensic tracking)
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
