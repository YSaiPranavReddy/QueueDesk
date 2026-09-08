/**
 * Centralised environment/config values with defaults and validation.
 * Import from here — never read process.env directly in business logic.
 */
import dotenv from 'dotenv';
dotenv.config();

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`[Config] Missing required environment variable: ${key}`);
  return val;
};

const optional = (key, defaultVal) => process.env[key] ?? defaultVal;

export const config = {
  port: parseInt(optional('PORT', '3001'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),
  isProd: optional('NODE_ENV', 'development') === 'production',

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessExpiry: optional('JWT_ACCESS_EXPIRY', '15m'),
    refreshExpiry: optional('JWT_REFRESH_EXPIRY', '7d'),
  },

  db: {
    url: required('DATABASE_URL'),
  },

  redis: {
    host: optional('REDIS_HOST', 'localhost'),
    port: parseInt(optional('REDIS_PORT', '6379'), 10),
  },

  cookie: {
    secret: required('COOKIE_SECRET'),
  },

  cors: {
    origins: optional('CORS_ORIGINS', 'http://localhost:5173').split(',').map((o) => o.trim()),
  },

  sla: {
    escalationMinutes: parseInt(optional('SLA_ESCALATION_MINUTES', '10'), 10),
    autoCloseMinutes: parseInt(optional('AUTO_CLOSE_MINUTES', '30'), 10),
    transcriptFlushMs: parseInt(optional('TRANSCRIPT_FLUSH_INTERVAL_MS', '30000'), 10),
  },

  email: {
    resendApiKey: required('RESEND_API_KEY'),
    from: optional('EMAIL_FROM', 'QueueDesk <onboarding@resend.dev>'),
    adminEmail: optional('ADMIN_EMAIL', ''),
  },
};
