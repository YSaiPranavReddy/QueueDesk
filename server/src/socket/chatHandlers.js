/**
 * Chat socket handlers — M6
 *
 * Message flow:
 *   client emits   chat:send       → { ticketId, body }
 *   server buffers RPUSH chat:buffer:{ticketId} <json>   (flushed to DB by worker in M9)
 *   server writes  DB directly (sync fallback — removed in M9 when worker is live)
 *   server emits   chat:message    → { message }  to ticket:{ticketId} room
 *   server emits   chat:typing     → { userId, isTyping } (pass-through, no DB write)
 *
 * Redis buffer key: chat:buffer:{ticketId}
 *   - Each entry: JSON string of the full message object
 *   - Worker (M9) will LRANGE + batch-INSERT + DEL every 30s
 *
 * Rooms:
 *   ticket:{ticketId} — both sides share this room
 *   Joined on socket connect if ticketId in query (customer)
 *   or on chat:join event (agent after claiming)
 */
import { v4 as uuidv4 } from 'uuid';
import redis from '../config/redis.js';
import { insertMessage } from '../models/message.js';
import { findTicketById } from '../models/ticket.js';

const bufferKey = (ticketId) => `chat:buffer:${ticketId}`;

/**
 * Register chat event listeners on a socket.
 * Called from socket/index.js for every authenticated connection.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 */
export const registerChatHandlers = (socket, io) => {
  const { id: senderId, role } = socket.user;

  // ── chat:join — agent joins a specific ticket room after claiming ────────────
  socket.on('chat:join', async ({ ticketId }) => {
    try {
      const ticket = await findTicketById(ticketId);
      if (!ticket) return;

      // Only the assigned agent, the owning customer, or an admin may join
      const isCustomer = role === 'customer' && ticket.customer_id === senderId;
      const isAgent    = role === 'agent'    && ticket.agent_id    === senderId;
      const isAdmin    = role === 'admin';

      if (!isCustomer && !isAgent && !isAdmin) return;

      socket.join(`ticket:${ticketId}`);

      // Send message history so agent sees previous messages immediately
      const { findMessagesByTicket } = await import('../models/message.js');
      const history = await findMessagesByTicket(ticketId, { limit: 50 });
      socket.emit('chat:history', { ticketId, messages: history });
    } catch (err) {
      console.error('[Chat] chat:join error:', err.message);
    }
  });

  // ── chat:status:request — request the online presence of the partner ──────────
  socket.on('chat:status:request', async ({ ticketId }) => {
    try {
      const ticket = await findTicketById(ticketId);
      if (!ticket) return;

      const partnerId = role === 'agent' ? ticket.customer_id : ticket.agent_id;
      if (!partnerId) return;
      
      const partnerRole = role === 'agent' ? 'customer' : 'agent';
      const partnerSockets = await io.in(`${partnerRole}:${partnerId}`).fetchSockets();
      
      // Emit correct event based on who is being queried (agent or customer)
      const onlineEvent  = partnerRole === 'customer' ? 'customer:online'  : 'agent:online';
      const offlineEvent = partnerRole === 'customer' ? 'customer:offline' : 'agent:offline';
      
      if (partnerSockets.length > 0) {
        socket.emit(onlineEvent,  { ticketId });
      } else {
        socket.emit(offlineEvent, { ticketId });
      }
    } catch (err) {
      console.error('[Chat] chat:status:request error:', err.message);
    }
  });

  // ── chat:send — either party sends a message ────────────────────────────────
  socket.on('chat:send', async ({ ticketId, body }) => {
    try {
      if (!ticketId || !body?.trim()) return;

      // Validate sender is in this ticket
      const ticket = await findTicketById(ticketId);
      if (!ticket) return;

      // NEW — closed tickets are permanently read-only, no exceptions
      if (ticket.status === 'closed') {
        socket.emit('chat:error', { message: 'This ticket is closed and cannot receive new messages' });
        return;
      }

      const isCustomer = role === 'customer' && ticket.customer_id === senderId;
      const isAgent    = role === 'agent'    && ticket.agent_id    === senderId;
      const isAdmin    = role === 'admin';

      if (!isCustomer && !isAgent && !isAdmin) return;

      const message = {
        id:         uuidv4(),
        ticket_id:  ticketId,
        sender_id:  senderId,
        sender_role: role,
        body:       body.trim(),
        created_at: new Date().toISOString(),
      };

      // 1. Buffer in Redis (M9 worker will batch-flush to DB)
      await redis.rpush(bufferKey(ticketId), JSON.stringify(message));

      // M11.T3: Invalidate message history cache
      await redis.del(`cache:ticket_history:${ticketId}`);

      // 3. Broadcast to the ticket room (both customer and agent see it instantly)
      io.to(`ticket:${ticketId}`).emit('chat:message', { message });

      // 3.5. Notification Trigger: Send email if the recipient is offline
      const partnerId = role === 'agent' ? ticket.customer_id : ticket.agent_id;
      if (partnerId) {
        const partnerRole = role === 'agent' ? 'customer' : 'agent';
        const partnerSockets = await io.in(`${partnerRole}:${partnerId}`).fetchSockets();
        
        if (partnerSockets.length === 0) {
          const { sendOfflineMessage } = await import('../services/notificationService.js');
          const senderName = role === 'agent' ? ticket.agent_name : ticket.customer_name;
          await sendOfflineMessage(ticketId, senderName || 'User', partnerId, partnerRole, body);
        }
      }

      // 4. Sticky Routing Re-activation
      // If a customer replies to an on-hold ticket, route them back to their original agent
      if (role === 'customer' && ticket.status === 'open' && ticket.agent_id) {
        // Send a system message to the room indicating they are being routed
        io.to(`ticket:${ticketId}`).emit('chat:message', {
          message: {
            id: uuidv4(),
            ticket_id: ticketId,
            sender_id: 'system',
            sender_role: 'system',
            body: 'We are connecting you to your agent. You will be notified when they are ready.',
            created_at: new Date().toISOString(),
          }
        });

        const { routeStickyTicket } = await import('../services/matchingService.js');
        await routeStickyTicket(senderId, ticketId, ticket.agent_id);
      }
    } catch (err) {
      console.error('[Chat] chat:send error:', err.message);
      socket.emit('chat:error', { message: 'Failed to send message' });
    }
  });

  // ── chat:typing — pass-through, no persistence ──────────────────────────────
  socket.on('chat:typing', ({ ticketId, isTyping }) => {
    socket.to(`ticket:${ticketId}`).emit('chat:typing', {
      userId: senderId,
      role,
      isTyping,
    });
  });

  // ── chat:history — client requests message history (e.g. on reconnect) ──────
  socket.on('chat:history', async ({ ticketId, before }) => {
    try {
      const ticket = await findTicketById(ticketId);
      if (!ticket) return;

      const isCustomer = role === 'customer' && ticket.customer_id === senderId;
      const isAgent    = role === 'agent'    && ticket.agent_id    === senderId;
      const isAdmin    = role === 'admin';

      if (!isCustomer && !isAgent && !isAdmin) return;

      const { findMessagesByTicket } = await import('../models/message.js');
      const messages = await findMessagesByTicket(ticketId, { limit: 50, before });
      socket.emit('chat:history', { ticketId, messages });
    } catch (err) {
      console.error('[Chat] chat:history error:', err.message);
    }
  });
};
