import { notificationQueue } from '../workers/notificationWorker.js';
import { query } from '../config/db.js';
import { config } from '../config/index.js';
import { 
  templateTicketAssigned, 
  templateTicketClosed, 
  templateOfflineMessage,
  templateTicketEscalated
} from '../utils/emailTemplates.js';

/**
 * Helper to fetch a user and check their notify_email preference.
 */
const getUserNotificationPref = async (userId) => {
  if (!userId) return null;
  const { rows } = await query(`SELECT email, name, notify_email FROM users WHERE id = $1`, [userId]);
  return rows[0] || null;
};

/**
 * Consolidate getting the ticket details + joining users.
 */
const getFullTicket = async (ticketId) => {
  const { rows } = await query(
    `SELECT t.*, 
            c.email AS customer_email, c.name AS customer_name, c.notify_email AS customer_notify,
            a.email AS agent_email, a.name AS agent_name, a.notify_email AS agent_notify
     FROM tickets t
     JOIN users c ON t.customer_id = c.id
     LEFT JOIN users a ON t.agent_id = a.id
     WHERE t.id = $1`,
    [ticketId]
  );
  return rows[0] || null;
};

/**
 * Enqueue an email job if the recipient allows it.
 */
const enqueueEmail = async (userId, userEmail, userNotify, templateResult, eventType, ticketId) => {
  if (userNotify === false) {
    console.log(`[NotificationService] Suppressing ${eventType} email for ${userEmail} (opted out)`);
    return false;
  }
  
  if (!userEmail) return false;

  await notificationQueue.add('email', {
    to: userEmail,
    subject: templateResult.subject,
    text: templateResult.text,
    html: templateResult.html,
    
    // Metadata for dead-letter logging (M10.T5)
    userId,
    ticketId,
    eventType
  }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  });
  
  return true;
};

/**
 * Send an email to the customer when an agent is assigned.
 */
export const sendTicketAssigned = async (ticketId) => {
  const ticket = await getFullTicket(ticketId);
  if (!ticket) return;

  const { getIo } = await import('../socket/index.js');
  const customerSockets = await getIo().in(`customer:${ticket.customer_id}`).fetchSockets();
  if (customerSockets.length > 0) {
    console.log(`[NotificationService] Customer ${ticket.customer_id} is online, skipping assigned email`);
    return;
  }

  const template = templateTicketAssigned({
    customerName: ticket.customer_name,
    agentName: ticket.agent_name || 'Agent',
    ticketSubject: ticket.subject,
    ticketId: ticket.id
  });

  await enqueueEmail(ticket.customer_id, ticket.customer_email, ticket.customer_notify, template, 'ticket_assigned', ticket.id);
};

/**
 * Send an email to the customer when the ticket is closed.
 */
export const sendTicketClosed = async (ticketId) => {
  const ticket = await getFullTicket(ticketId);
  if (!ticket) return;

  const template = templateTicketClosed({
    customerName: ticket.customer_name,
    agentName: ticket.agent_name,
    ticketSubject: ticket.subject
  });

  await enqueueEmail(ticket.customer_id, ticket.customer_email, ticket.customer_notify, template, 'ticket_closed', ticket.id);
};

/**
 * Send an email when a message is received while offline.
 */
export const sendOfflineMessage = async (ticketId, senderName, recipientId, recipientRole, body) => {
  const ticket = await getFullTicket(ticketId);
  if (!ticket) return;

  const recipientEmail = recipientRole === 'agent' ? ticket.agent_email : ticket.customer_email;
  const recipientName = recipientRole === 'agent' ? ticket.agent_name : ticket.customer_name;
  const recipientNotify = recipientRole === 'agent' ? ticket.agent_notify : ticket.customer_notify;

  const template = templateOfflineMessage({
    recipientName,
    senderName,
    ticketSubject: ticket.subject,
    body
  });

  await enqueueEmail(recipientId, recipientEmail, recipientNotify, template, 'offline_message', ticket.id);
};

/**
 * Send an email to admins when a ticket is escalated.
 * (In a real system, you might loop through all admins. For now, we'll send to a configured admin address or just the assigned agent).
 */
export const sendTicketEscalated = async (ticketId) => {
  const ticket = await getFullTicket(ticketId);
  if (!ticket) return;

  const adminEmail = config.email.adminEmail;
  if (!adminEmail) {
    console.warn('[NotificationService] ADMIN_EMAIL not set — skipping SLA escalation email');
    return;
  }

  const template = templateTicketEscalated({
    agentName: ticket.agent_name,
    ticketSubject: ticket.subject,
    adminEmail,
  });

  await notificationQueue.add('email', {
    to: adminEmail,
    subject: template.subject,
    text: template.text,
    html: template.html,
    userId: null,
    ticketId: ticket.id,
    eventType: 'ticket_escalated'
  }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  });
};
