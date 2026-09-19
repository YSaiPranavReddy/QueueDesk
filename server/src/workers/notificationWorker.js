import { Queue, Worker } from 'bullmq';
import nodemailer from 'nodemailer';
import { createRedisClient } from '../config/redis.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { notificationDeadLetterTotal, emailDeliveryLatencySeconds } from '../utils/metrics.js';

const connection = createRedisClient();

export const notificationQueue = new Queue('notifications', { connection });

// Nodemailer transport (fallback for non-Brevo hosts like Ethereal)
const transporter = nodemailer.createTransport({
  host: config.email.smtpHost,
  port: config.email.smtpPort,
  secure: config.email.smtpPort === 465,
  auth: {
    user: config.email.smtpUser,
    pass: config.email.smtpPass,
  },
});

export const notificationWorker = new Worker('notifications', async (job) => {
  if (job.name === 'email') {
    const endTimer = emailDeliveryLatencySeconds.startTimer();
    const { to, subject, html, text } = job.data;

    try {
      if (config.email.smtpHost.includes('brevo')) {
        logger.info({ to, subject }, `[Worker] Sending email via Brevo HTTP API`);
        
        // Parse "Name <email@domain.com>" format
        const fromName = config.email.from.split('<')[0].trim() || 'QueueDesk';
        const fromEmail = config.email.from.match(/<([^>]+)>/)?.[1] || config.email.from;

        const response = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'api-key': config.email.smtpPass,
          },
          body: JSON.stringify({
            sender: { name: fromName, email: fromEmail },
            to: [{ email: to }],
            subject,
            htmlContent: html,
            textContent: text
          })
        });

        if (!response.ok) {
          const errData = await response.text();
          throw new Error(`Brevo API Error ${response.status}: ${errData}`);
        }
        
        logger.info({ to, subject }, `[Worker] Email delivered via Brevo HTTP API`);
      } else {
        logger.info({ to, subject }, `[Worker] Sending email via standard SMTP`);
        const info = await transporter.sendMail({
          from: config.email.from,
          to,
          subject,
          html,
          text,
        });
        logger.info({ messageId: info.messageId, to, subject }, `[Worker] Email delivered via SMTP`);
      }
    } catch (error) {
      // Throw so BullMQ treats it as a failed job and retries
      throw new Error(error.message);
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

