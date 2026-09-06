import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { logger } from './utils/logger.js';
import metricsRegister from './utils/metrics.js';
import { query } from './config/db.js';
import redis from './config/redis.js';
import cookieParser from 'cookie-parser';

import { config } from './config/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { initSocket } from './socket/index.js';
import './workers/disconnectWorker.js';
import './workers/reminderWorker.js';
import './workers/slaWorker.js';
import './workers/notificationWorker.js';
import './workers/transcriptWorker.js';
import './workers/autoCloseWorker.js';

// ── Routes (added per milestone) ──────────────────────────────────────────────
import authRoutes    from './routes/auth.js';
import ticketRoutes  from './routes/tickets.js';
import messageRoutes from './routes/messages.js';
import agentRoutes   from './routes/agents.js';

const app = express();
const server = http.createServer(app);

// ── Security & Parsing Middleware ─────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: config.cors.origins,
    credentials: true, // Allow cookies (refresh token)
  })
);
app.use(pinoHttp({ 
  logger, 
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/metrics',
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(config.cookie.secret));

// ── Observability (Metrics & Health) ──────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metricsRegister.contentType);
  res.end(await metricsRegister.metrics());
});

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    await redis.ping();
    res.json({
      status: 'ok',
      instanceId: process.env.INSTANCE_ID || process.env.PORT || '1',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, 'Health check failed');
    res.status(503).json({ status: 'error', reason: 'dependency_failure' });
  }
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',              authRoutes);
app.use('/api/tickets',           ticketRoutes);
app.use('/api/tickets/:id/messages', messageRoutes);
app.use('/api/agents',            agentRoutes);

// ── 404 + Global Error Handler ────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(config.port, async () => {
  logger.info(`[Server] QueueDesk running on port ${config.port} (${config.nodeEnv}), Instance: ${process.env.INSTANCE_ID || process.env.PORT || '1'}`);
  await initSocket(server);
  
  const { startStatsWorker } = await import('./workers/statsWorker.js');
  startStatsWorker();
});

export { server, app };
