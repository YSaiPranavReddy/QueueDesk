/**
 * Email Templates — ES6 literals natively compiled by V8 for maximum performance.
 */

export const templateTicketAssigned = ({ customerName, agentName, ticketSubject, ticketId }) => ({
  subject: `Agent Assigned: ${ticketSubject}`,
  text: `Hi ${customerName},\n\nAn agent (${agentName}) has joined your ticket "${ticketSubject}".\n\nPlease log in to your dashboard to chat.`,
  html: `
    <div style="font-family: sans-serif; padding: 20px;">
      <h2>Agent Assigned</h2>
      <p>Hi <strong>${customerName}</strong>,</p>
      <p>An agent (<strong>${agentName}</strong>) has joined your ticket "<em>${ticketSubject}</em>".</p>
      <p>Please log in to your QueueDesk dashboard to chat.</p>
    </div>
  `
});

export const templateTicketClosed = ({ customerName, agentName, ticketSubject }) => ({
  subject: `Ticket Closed: ${ticketSubject}`,
  text: `Hi ${customerName},\n\nYour ticket "${ticketSubject}" has been marked as closed by ${agentName || 'an agent'}.\n\nThank you for using QueueDesk!`,
  html: `
    <div style="font-family: sans-serif; padding: 20px;">
      <h2>Ticket Closed</h2>
      <p>Hi <strong>${customerName}</strong>,</p>
      <p>Your ticket "<em>${ticketSubject}</em>" has been marked as closed by ${agentName || 'an agent'}.</p>
      <p>Thank you for using QueueDesk!</p>
    </div>
  `
});

export const templateOfflineMessage = ({ recipientName, senderName, ticketSubject, body }) => ({
  subject: `New message on ticket: ${ticketSubject}`,
  text: `Hi ${recipientName},\n\nYou have a new message from ${senderName} on ticket "${ticketSubject}":\n\n"${body}"\n\nPlease log in to your dashboard to reply.`,
  html: `
    <div style="font-family: sans-serif; padding: 20px;">
      <h2>New Message</h2>
      <p>Hi <strong>${recipientName}</strong>,</p>
      <p>You have a new message from <strong>${senderName}</strong> on ticket "<em>${ticketSubject}</em>":</p>
      <blockquote style="border-left: 4px solid #ccc; margin-left: 0; padding-left: 10px; color: #555;">
        ${body}
      </blockquote>
      <p>Please log in to your QueueDesk dashboard to reply.</p>
    </div>
  `
});

export const templateTicketEscalated = ({ agentName, ticketSubject, adminEmail }) => ({
  subject: `SLA Escalation: ${ticketSubject}`,
  text: `SLA Breach Alert,\n\nThe ticket "${ticketSubject}" has breached its SLA and has been escalated.\nAssigned to: ${agentName || 'Unassigned'}.`,
  html: `
    <div style="font-family: sans-serif; padding: 20px; color: #d32f2f;">
      <h2>SLA Escalation Alert</h2>
      <p>The ticket "<strong>${ticketSubject}</strong>" has breached its SLA and has been automatically escalated.</p>
      <p>Currently assigned to: <strong>${agentName || 'Unassigned'}</strong></p>
      <p>Please review immediately.</p>
    </div>
  `
});
