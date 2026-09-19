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
    <div style="font-family: sans-serif; padding: 20px;">
      <h2>SLA Escalation</h2>
      <p>The ticket "<em>${ticketSubject}</em>" has breached its SLA and has been escalated.</p>
      <p>Assigned to: <strong>${agentName || 'Unassigned'}</strong>.</p>
    </div>
  `
});

export const templatePasswordReset = ({ name, resetUrl }) => ({
  subject: 'Reset your QueueDesk password',
  text: `Hi ${name},\n\nYou requested a password reset for your QueueDesk account.\n\nClick the link below to reset your password (expires in 15 minutes):\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email. Your password will not change.\n\n— The QueueDesk Team`,
  html: `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; background: #0f1117; border-radius: 12px; overflow: hidden; border: 1px solid #1e2130;">
      <div style="background: linear-gradient(135deg, #1a1f35 0%, #0f1117 100%); padding: 32px 32px 24px; text-align: center; border-bottom: 1px solid #1e2130;">
        <div style="font-size: 28px; font-weight: 700; color: #fff; letter-spacing: -0.5px;">
          Queue<span style="color: #6366f1;">Desk</span>
        </div>
      </div>
      <div style="padding: 32px;">
        <h2 style="color: #f1f5f9; font-size: 20px; font-weight: 600; margin: 0 0 12px;">Reset your password</h2>
        <p style="color: #94a3b8; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
          Hi <strong style="color: #e2e8f0;">${name}</strong>, we received a request to reset the password for your QueueDesk account.
        </p>
        <p style="color: #94a3b8; font-size: 14px; margin: 0 0 24px;">
          Click the button below to choose a new password. This link expires in <strong style="color: #f59e0b;">15 minutes</strong>.
        </p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-weight: 600; font-size: 15px; text-decoration: none; padding: 13px 32px; border-radius: 8px; letter-spacing: 0.2px;">
            Reset Password →
          </a>
        </div>
        <p style="color: #64748b; font-size: 13px; margin: 24px 0 0; padding-top: 20px; border-top: 1px solid #1e2130;">
          If you didn't request a password reset, you can safely ignore this email. Your account is secure.
        </p>
      </div>
      <div style="padding: 16px 32px; background: #0a0d14; text-align: center;">
        <p style="color: #475569; font-size: 12px; margin: 0;">© 2025 QueueDesk. All rights reserved.</p>
      </div>
    </div>
  `
});

export const templateEmailVerification = ({ name, verifyUrl }) => ({
  subject: 'Verify your QueueDesk email address',
  text: `Hi ${name},\n\nWelcome to QueueDesk! Please verify your email address by clicking the link below:\n${verifyUrl}\n\nThis link expires in 24 hours.\n\nIf you didn't create a QueueDesk account, you can safely ignore this email.\n\n— The QueueDesk Team`,
  html: `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; background: #0f1117; border-radius: 12px; overflow: hidden; border: 1px solid #1e2130;">
      <div style="background: linear-gradient(135deg, #1a1f35 0%, #0f1117 100%); padding: 32px 32px 24px; text-align: center; border-bottom: 1px solid #1e2130;">
        <div style="font-size: 28px; font-weight: 700; color: #fff; letter-spacing: -0.5px;">
          Queue<span style="color: #6366f1;">Desk</span>
        </div>
      </div>
      <div style="padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="width: 56px; height: 56px; background: linear-gradient(135deg, #6366f1, #8b5cf6); border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 24px;">✉️</div>
        </div>
        <h2 style="color: #f1f5f9; font-size: 20px; font-weight: 600; margin: 0 0 12px; text-align: center;">Verify your email</h2>
        <p style="color: #94a3b8; font-size: 15px; line-height: 1.6; margin: 0 0 8px;">
          Hi <strong style="color: #e2e8f0;">${name}</strong>,
        </p>
        <p style="color: #94a3b8; font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
          Welcome to QueueDesk! Click below to verify your email and activate your account.
        </p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-weight: 600; font-size: 15px; text-decoration: none; padding: 13px 32px; border-radius: 8px; letter-spacing: 0.2px;">
            Verify Email Address →
          </a>
        </div>
        <p style="color: #64748b; font-size: 13px; margin: 24px 0 0; padding-top: 20px; border-top: 1px solid #1e2130;">
          This link expires in <strong style="color: #f59e0b;">24 hours</strong>. If you didn't create a QueueDesk account, you can safely ignore this email.
        </p>
      </div>
      <div style="padding: 16px 32px; background: #0a0d14; text-align: center;">
        <p style="color: #475569; font-size: 12px; margin: 0;">© 2025 QueueDesk. All rights reserved.</p>
      </div>
    </div>
  `
});
