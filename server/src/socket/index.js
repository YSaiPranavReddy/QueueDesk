/**
 * Socket.IO server — M4
 *
 * Architecture:
 *   Single Socket.IO server attached to the Express HTTP server.
 *   Redis adapter (@socket.io/redis-adapter) means all events are
 *   broadcast across every Node process — ready for horizontal scaling (M7).
 *
 * Room scheme:
 *   ticket:{ticketId}     — customer + assigned agent share this room
 *   agent:{agentId}       — agent's private room (new-ticket notifications)
 *   customer:{customerId} — customer's private room (queue position updates)
 *
 * Events emitted by server → client:
 *   queue:position          — { position, estimatedWaitMs }         → customer waiting
 *   ticket:matched          — { ticketId, agentId, agentName }      → customer matched
 *   ticket:assigned         — { ticket }                            → agent: new ticket
 *   ticket:closed           — { ticketId }                         → both sides
 *   chat:message            — { message }                          → M6
 *
 * Events received from client → server:
 *   ping:queue              — customer requests their current position
 */
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createRedisClient } from "../config/redis.js";
import { authenticateSocket } from "../middleware/auth.js";
import { config } from "../config/index.js";
import { logger } from '../utils/logger.js';
import { queueUpdateLatencySeconds } from '../utils/metrics.js';
import { registerChatHandlers } from "./chatHandlers.js";
import { disconnectQueue } from "../workers/disconnectWorker.js";

let io = null;

export const getIo = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};

/**
 * Initialize Socket.IO and attach to the HTTP server.
 * Call once during server startup.
 *
 * @param {import('http').Server} httpServer
 */
export const initSocket = async (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: config.cors.origins,
      credentials: true,
    },
    // Prefer WebSocket, fall back to polling
    transports: ["websocket", "polling"],
  });

  // ── Redis adapter for horizontal scaling (M7) ───────────────────────────────
  // Two separate Redis connections required by the adapter (pub + sub)
  const pubClient = createRedisClient();
  const subClient = createRedisClient();
  io.adapter(createAdapter(pubClient, subClient));
  logger.info("[Socket.IO] Redis adapter connected");

  // ── Auth middleware ─────────────────────────────────────────────────────────
  // Validates JWT from handshake query param or Authorization header.
  // Populated by authenticateSocket → socket.user = { id, email, role }
  io.use(authenticateSocket);

  // ── Connection handler ──────────────────────────────────────────────────────
  io.on("connection", async (socket) => {
    const { id: userId, role } = socket.user;
      
    // Cancel any pending disconnect jobs upon reconnect
    try {
      const { findTickets } = await import("../models/ticket.js");
      if (role === 'customer') {
        const tickets = await findTickets({ customerId: userId, status: "assigned" });
        for (const t of tickets) {
          const jobId = `cust-abandon-${t.id}`;
          const job = await disconnectQueue.getJob(jobId);
          if (job) await job.remove();
        }
      } else if (role === 'agent') {
        const tickets = await findTickets({ agentId: userId, status: "assigned" });
        for (const t of tickets) {
          const jobId = `agent-dc-${userId}-${t.id}`;
          const job = await disconnectQueue.getJob(jobId);
          if (job) await job.remove();
        }
      }
    } catch (err) {
      logger.error("[Socket.IO] Error cancelling reconnect jobs:", err.message);
    }

    logger.info(`[Socket.IO] Connected: ${role} ${userId} (${socket.id})`);

    // Every user joins their private room automatically
    socket.join(`${role}:${userId}`);

    // ── Join all active ticket rooms for this user (Agent & Customer) ────────
    (async () => {
      try {
        const { query } = await import("../config/db.js");
        let activeTickets = [];
        
        if (role === 'customer') {
          const { rows } = await query(`SELECT id FROM tickets WHERE customer_id = $1 AND status != 'closed'`, [userId]);
          activeTickets = rows;
        } else if (role === 'agent') {
          const { rows } = await query(`SELECT id FROM tickets WHERE agent_id = $1 AND status != 'closed'`, [userId]);
          activeTickets = rows;
        }

        for (const t of activeTickets) {
          socket.join(`ticket:${t.id}`);
          // NEW: broadcast presence back to the agent if this is a reconnecting customer
          if (role === 'customer') {
            socket.to(`ticket:${t.id}`).emit('customer:online', { ticketId: t.id, customerId: userId });
          }
        }
      } catch (err) {
        logger.error("[Socket] Auto-join error:", err.message);
      }
    })();

    // ── Agent: join their private agent room ──────────────────────────────────
    if (role === "agent") {
      socket.join(`agent:${userId}`);
      socket.join('agents'); // NEW — shared room for all connected agents
    }

    // ── Register chat handlers ────────────────────────────────────────────────
    registerChatHandlers(socket, io);

    // ── M11.T1: Agent Heartbeat (TTL) ─────────────────────────────────────────
    if (role === 'agent') {
      socket.on("ping:agent", async () => {
        try {
          const { refreshAgentTTL } = await import("../services/matchingService.js");
          await refreshAgentTTL(userId);
        } catch (err) {
          logger.error("[Socket.IO] ping:agent error:", err.message);
        }
      });
    }

    // ── Customer requests queue position refresh ──────────────────────────────
    socket.on("ping:queue", async () => {
      try {
        const { getQueuePosition, getEstimatedWait } =
          await import("../services/matchingService.js");
        const position = await getQueuePosition(userId);
        if (position !== null) {
          const estimatedWaitMs = await getEstimatedWait(position);
          socket.emit("queue:position", { position, estimatedWaitMs });
        }
      } catch (err) {
        logger.error("[Socket.IO] ping:queue error:", err.message);
      }
    });

    socket.on("disconnect", async (reason) => {
      logger.info(`[Socket.IO] Disconnected: ${role} ${userId} — ${reason}`);

      if (role === "agent") {
        try {
          const { markAgentOffline, getAgentStatus } =
            await import("../services/matchingService.js");
          const { findTickets, findTicketById } =
            await import("../models/ticket.js");
          const { recirculateTicket } =
            await import("../services/claimService.js");

          await markAgentOffline(userId);

          // Find active tickets for this agent
          const activeTickets = await findTickets({
            agentId: userId,
            status: "assigned",
          });

          activeTickets.forEach((ticket) => {
            disconnectQueue.add(
              'disconnect',
              { type: 'agent-disconnect', userId, ticketId: ticket.id },
              { jobId: `agent-dc-${userId}-${ticket.id}`, delay: 30000 }
            );
          });
        } catch (err) {
          logger.error("[Socket.IO] Disconnect handler error:", err.message);
        }
      } else if (role === "customer") {
        try {
          const { removeFromQueue, getQueueMembers } = await import("../services/matchingService.js");
          const { findPendingTicketByCustomerId, findTickets } = await import("../models/ticket.js");

          // Always clean up Redis queue immediately, regardless of DB state
          await removeFromQueue(userId);

          const ticket = await findPendingTicketByCustomerId(userId);
          if (ticket) {
            logger.info({ ticketId: ticket.id, customerId: userId }, `[Socket.IO] Customer disconnected. Removed from queue, left ticket pending.`);
          }

          // If the customer was already in a live chat (assigned), start an abandonment timer
          const assignedTickets = await findTickets({ customerId: userId, status: "assigned" });
          if (assignedTickets.length > 0) {
            const { releaseAgent } = await import("../services/claimService.js");
            const { closeTicket, findTicketById } = await import("../models/ticket.js");
            const ABANDON_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
            
            for (const t of assignedTickets) {
              // Tell the agent the customer lost connection
              io.to(`ticket:${t.id}`).emit('customer:offline', { ticketId: t.id, customerId: userId });
              
              disconnectQueue.add(
                'disconnect',
                { type: 'customer-abandon', userId, ticketId: t.id },
                { jobId: `cust-abandon-${t.id}`, delay: ABANDON_TIMEOUT_MS }
              );
            }
          }

          const remaining = await getQueueMembers();
          if (remaining.length > 0) {
            // M11.T2: statsWorker.js now handles broadcasting position updates every 10s
          }
        } catch (err) {
          logger.error({ err }, "[Socket.IO] Customer disconnect cleanup error");
        }
      }
    });
  });

  return io;
};

// ── Emitter helpers (called from routes & services) ───────────────────────────

/**
 * Notify a waiting customer of their current queue position.
 * @param {string} customerId
 * @param {number} position
 * @param {number} estimatedWaitMs
 */
export const emitQueuePosition = (customerId, position, estimatedWaitMs) => {
  getIo()
    .to(`customer:${customerId}`)
    .emit("queue:position", { position, estimatedWaitMs });
};

/**
 * Notify a customer they've been matched with an agent.
 * @param {string} customerId
 * @param {string} ticketId
 * @param {string} agentId
 * @param {string} agentName
 */
export const emitTicketMatched = (customerId, ticketId, agentId, agentName) => {
  getIo()
    .to(`customer:${customerId}`)
    .emit("ticket:matched", { ticketId, agentId, agentName });
};

/**
 * Notify an agent they've been assigned a new ticket.
 * @param {string} agentId
 * @param {object} ticket - Full ticket object
 */
export const emitTicketAssigned = (agentId, ticket) => {
  getIo().to(`agent:${agentId}`).emit("ticket:assigned", { ticket });
};

/**
 * Broadcast a ticket closed event to both customer and agent in the room.
 * @param {string} ticketId
 */
export const emitTicketClosed = (ticketId) => {
  getIo().to(`ticket:${ticketId}`).emit("ticket:closed", { ticketId });
};


/**
 * Force an agent's active socket(s) into a ticket room server-side.
 * Used during assignments where the agent didn't initiate the action.
 * @param {string} agentId
 * @param {string} ticketId
 */
export const joinAgentToTicketRoom = async (agentId, ticketId) => {
  const ioInstance = getIo();
  ioInstance.in(`agent:${agentId}`).socketsJoin(`ticket:${ticketId}`);
};

/**
 * Force a customer's active socket(s) into a ticket room server-side.
 * Used during assignments where the customer didn't initiate the action.
 * @param {string} customerId
 * @param {string} ticketId
 */
export const joinCustomerToTicketRoom = async (customerId, ticketId) => {
  const ioInstance = getIo();
  ioInstance.in(`customer:${customerId}`).socketsJoin(`ticket:${ticketId}`);
};

/**
 * Broadcast updated queue positions to ALL currently waiting customers.
 * Called after every match (so position 2 becomes position 1, etc.)
 *
 * @param {string[]} customerIds — ordered queue members (from Redis ZRANGE)
 */
export const broadcastQueueShift = async (customerIds) => {
  const startTimer = queueUpdateLatencySeconds.startTimer();
  const { getEstimatedWaitBatch } = await import("../services/matchingService.js");
  const ioInstance = getIo();

  const positions = customerIds.map((_, i) => i + 1);
  const estimatedWaits = await getEstimatedWaitBatch(positions);

  for (let i = 0; i < customerIds.length; i++) {
    ioInstance
      .to(`customer:${customerIds[i]}`)
      .emit("queue:position", { position: positions[i], estimatedWaitMs: estimatedWaits[i] });
  }
  startTimer(); // Stops timer and records latency
};

/**
 * Broadcast a newly-pending ticket to all connected agents (not customers).
 * Used when a ticket lands in the queue instead of being instantly matched,
 * so agents' dashboards update live without needing a refresh.
 *
 * @param {object} ticket - Full ticket object
 */
export const emitTicketPending = (ticket) => {
  getIo().to('agents').emit('ticket:pending', { ticket });
};
