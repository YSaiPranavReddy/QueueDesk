/**
 * QueueDesk email templates.
 *
 * - Every template returns { subject, text, html } (same shape as before).
 * - All user-supplied values are HTML-escaped; URLs are validated.
 * - One shared layout keeps the look consistent and easy to change.
 * - Table-based, inline-styled HTML for Gmail / Outlook / Apple Mail,
 *   with a dark-mode override for clients that support it.
 *
 * Optional env vars:
 *   APP_URL        e.g. https://app.queuedesk.com  (used for "Open dashboard" buttons)
 *   SUPPORT_EMAIL  e.g. support@queuedesk.com      (shown in footers)
 */

const BRAND = {
  name: "QueueDesk",
  accent: "#4f46e5",
  accentDark: "#818cf8",
  appUrl: process.env.APP_URL || "",
  supportEmail: process.env.SUPPORT_EMAIL || "",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a value for safe use in HTML text or attribute context. */
const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Escape, then keep the sender's line breaks. */
const escMultiline = (value) => esc(value).replace(/\r?\n/g, "<br>");

/** Subjects must be single-line (prevents header injection) and a sane length. */
const cleanSubject = (value, max = 150) => {
  const s = String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Only allow http(s) links; anything else becomes null. */
const safeUrl = (value) => {
  if (!value) return null;
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
};

const orFallback = (value, fallback) => {
  const s = String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  return s || fallback;
};

const greeting = (name) =>
  String(name ?? "").trim() ? `Hi ${String(name).trim()},` : "Hi there,";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const styles = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .qd-bg { background: #0b0d12 !important; }
    .qd-card { background: #151823 !important; border-color: #262b3b !important; }
    .qd-title, .qd-strong { color: #f1f5f9 !important; }
    .qd-text { color: #b6c0d1 !important; }
    .qd-muted { color: #8391a7 !important; }
    .qd-quote { background: #1d2130 !important; border-color: #818cf8 !important; color: #dbe2ee !important; }
    .qd-rule { border-color: #262b3b !important; }
    .qd-btn { background: #818cf8 !important; color: #0b0d12 !important; }
    .qd-link { color: #a5b4fc !important; }
  }
  @media only screen and (max-width: 620px) {
    .qd-card { border-radius: 0 !important; }
    .qd-pad { padding: 24px 20px !important; }
  }
`;

const button = (label, url) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 28px 0 4px;">
    <tr>
      <td align="center" bgcolor="${BRAND.accent}" class="qd-btn" style="border-radius: 8px; background: ${BRAND.accent};">
        <a href="${esc(url)}" target="_blank" rel="noopener"
           style="display: inline-block; padding: 13px 28px; font-family: ${FONT}; font-size: 15px; font-weight: 600; line-height: 1; color: #ffffff; text-decoration: none; border-radius: 8px;">
          ${esc(label)}
        </a>
      </td>
    </tr>
  </table>`;

const p = (html, extra = "") =>
  `<p class="qd-text" style="margin: 0 0 16px; font-size: 15px; line-height: 1.65; color: #475569; ${extra}">${html}</p>`;

const strong = (value) =>
  `<strong class="qd-strong" style="color: #0f172a;">${esc(value)}</strong>`;

const detailRow = (label, valueHtml) => `
  <tr>
    <td class="qd-muted" style="padding: 6px 16px 6px 0; font-size: 14px; color: #64748b; white-space: nowrap; vertical-align: top;">${esc(label)}</td>
    <td class="qd-strong" style="padding: 6px 0; font-size: 14px; color: #0f172a; font-weight: 600;">${valueHtml}</td>
  </tr>`;

const detailsTable = (rows) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 8px;">
    ${rows.join("")}
  </table>`;

/**
 * Shared shell for every email.
 * @param {object} o
 * @param {string} o.preheader   Inbox preview text (hidden in the body).
 * @param {string} o.title       Heading inside the email.
 * @param {string} o.bodyHtml    Pre-escaped body markup.
 * @param {{label:string,url:string}|null} [o.cta]
 * @param {string} [o.footerNote] Plain text shown above the footer rule.
 */
const layout = ({
  preheader,
  title,
  bodyHtml,
  cta = null,
  footerNote = "",
}) => {
  const year = new Date().getFullYear();
  const support = BRAND.supportEmail
    ? ` Need help? <a class="qd-link" href="mailto:${esc(BRAND.supportEmail)}" style="color: ${BRAND.accent};">${esc(BRAND.supportEmail)}</a>.`
    : "";

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${esc(title)}</title>
  <style>${styles}</style>
</head>
<body style="margin: 0; padding: 0; background: #f1f5f9;" class="qd-bg">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent; mso-hide: all;">
    ${esc(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="qd-bg" style="background: #f1f5f9;">
    <tr>
      <td align="center" style="padding: 32px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="qd-card"
               style="max-width: 560px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; font-family: ${FONT};">
          <tr>
            <td class="qd-pad" style="padding: 28px 36px 0;">
              <div style="font-size: 20px; font-weight: 700; letter-spacing: -0.3px; color: #0f172a;" class="qd-title">
                Queue<span style="color: ${BRAND.accent};">Desk</span>
              </div>
            </td>
          </tr>
          <tr>
            <td class="qd-pad" style="padding: 24px 36px 32px;">
              <h1 class="qd-title" style="margin: 0 0 16px; font-size: 22px; line-height: 1.3; font-weight: 700; color: #0f172a;">${esc(title)}</h1>
              ${bodyHtml}
              ${cta ? button(cta.label, cta.url) : ""}
              ${
                footerNote
                  ? `<p class="qd-muted qd-rule" style="margin: 28px 0 0; padding-top: 18px; border-top: 1px solid #e2e8f0; font-size: 13px; line-height: 1.6; color: #64748b;">${esc(footerNote)}</p>`
                  : ""
              }
            </td>
          </tr>
          <tr>
            <td class="qd-pad qd-rule" style="padding: 16px 36px 24px; border-top: 1px solid #e2e8f0;">
              <p class="qd-muted" style="margin: 0; font-size: 12px; line-height: 1.6; color: #64748b;">
                &copy; ${year} ${BRAND.name}. You're receiving this because of activity on your ${BRAND.name} account.${support}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

/** Plain-text counterpart: same content, no markup, consistent sign-off. */
const textBody = (lines, cta = null) =>
  [
    ...lines,
    ...(cta ? ["", `${cta.label}: ${cta.url}`] : []),
    "",
    `— The ${BRAND.name} team`,
  ].join("\n");

const dashboardCta = (label, explicitUrl) => {
  const url = safeUrl(explicitUrl) || safeUrl(BRAND.appUrl);
  return url ? { label, url } : null;
};

// ---------------------------------------------------------------------------
// Ticket notifications
// ---------------------------------------------------------------------------

export const templateTicketAssigned = ({
  customerName,
  agentName,
  ticketSubject,
  ticketId,
  ticketUrl,
}) => {
  const agent = orFallback(agentName, "A support agent");
  const subject = orFallback(ticketSubject, "your ticket");
  const cta = dashboardCta("Open conversation", ticketUrl);

  return {
    subject: cleanSubject(`${agent} is now handling: ${subject}`),
    text: textBody(
      [
        greeting(customerName),
        "",
        "“Eppudu vacham annadi kaadu annaya… ticket teesukunnama leda annadi.”",
        "",
        `${agent} has joined your ticket "${subject}"${ticketId ? ` (#${ticketId})` : ""} and will help you from here.`,
        cta ? "" : "Log in to your dashboard to chat.",
      ].filter((l, i, a) => !(l === "" && a[i - 1] === "")),
      cta,
    ),
    html: layout({
      preheader: `${agent} has joined your ticket "${subject}".`,
      title: "An agent is on your ticket",
      bodyHtml:
        p(`${esc(greeting(customerName))}`) +
        p(
          "“Eppudu vacham annadi kaadu annaya… ticket teesukunnama leda annadi.”",
          "font-size: 16px; font-weight: 700;",
        ) +
        p(
          `${strong(agent)} has joined your ticket and will help you from here.`,
        ) +
        detailsTable([
          detailRow("Subject", esc(subject)),
          ...(ticketId ? [detailRow("Ticket", `#${esc(ticketId)}`)] : []),
          detailRow("Agent", esc(agent)),
        ]) +
        (cta ? "" : p("Log in to your dashboard to chat.")),
      cta,
    }),
  };
};

export const templateTicketClosed = ({
  customerName,
  agentName,
  ticketSubject,
  ticketId,
  ticketUrl,
}) => {
  const agent = orFallback(agentName, "an agent");
  const subject = orFallback(ticketSubject, "your ticket");
  const cta = dashboardCta("View ticket", ticketUrl);

  return {
    subject: cleanSubject(`Resolved: ${subject}`),
    text: textBody(
      [
        greeting(customerName),
        "",
        "“Taggede le.”",
        "",
        `Your ticket "${subject}"${ticketId ? ` (#${ticketId})` : ""} was closed by ${agent}.`,
        "If something is still not working, reply on the ticket or open a new one and we will pick it up.",
        "",
        `Thank you for using ${BRAND.name}.`,
      ],
      cta,
    ),
    html: layout({
      preheader: `Your ticket "${subject}" has been closed.`,
      title: "Your ticket is closed",
      bodyHtml:
        p(esc(greeting(customerName))) +
        p("“Taggede le.”", "font-size: 18px; font-weight: 700;") +
        p(`${strong(agent)} closed your ticket.`) +
        detailsTable([
          detailRow("Subject", esc(subject)),
          ...(ticketId ? [detailRow("Ticket", `#${esc(ticketId)}`)] : []),
        ]) +
        p(
          "If something is still not working, reply on the ticket or open a new one and we will pick it up.",
          "margin-top: 12px;",
        ) +
        p(`Thank you for using ${BRAND.name}.`),
      cta,
    }),
  };
};

export const templateOfflineMessage = ({
  recipientName,
  senderName,
  ticketSubject,
  body,
  ticketUrl,
}) => {
  const sender = orFallback(senderName, "Someone");
  const subject = orFallback(ticketSubject, "your ticket");
  const message = String(body ?? "").trim();
  // Keep email previews short; the full message lives in the dashboard.
  const MAX = 1000;
  const shown =
    message.length > MAX ? `${message.slice(0, MAX).trimEnd()}…` : message;
  const cta = dashboardCta("Reply in dashboard", ticketUrl);

  return {
    subject: cleanSubject(`New message from ${sender}: ${subject}`),
    text: textBody(
      [
        greeting(recipientName),
        "",
        "“Yendi emmana matladandi, oka paata padandi… meeku message ochindhi andi.”",
        "",
        `${sender} sent you a message on "${subject}":`,
        "",
        ...shown.split(/\r?\n/).map((l) => `> ${l}`),
        ...(message.length > MAX ? ["> …"] : []),
        "",
        cta ? "" : "Log in to your dashboard to reply.",
      ].filter((l, i, a) => !(l === "" && a[i - 1] === "")),
      cta,
    ),
    html: layout({
      preheader:
        shown.replace(/\s+/g, " ").slice(0, 110) ||
        `New message on "${subject}"`,
      title: `New message from ${sender}`,
      bodyHtml:
        p(esc(greeting(recipientName))) +
        p(
          "“Yendi emmana matladandi, oka paata padandi… meeku message ochindhi andi.”",
          "font-size: 16px; font-weight: 700;",
        ) +
        p(`${strong(sender)} sent you a message on ${strong(subject)}:`) +
        `<div class="qd-quote" style="margin: 4px 0 8px; padding: 14px 16px; background: #f8fafc; border-left: 4px solid ${BRAND.accent}; border-radius: 0 8px 8px 0; font-size: 15px; line-height: 1.65; color: #1e293b; word-break: break-word;">${escMultiline(shown)}</div>` +
        (cta ? "" : p("Log in to your dashboard to reply.")),
      cta,
      footerNote:
        "You got this email because you were offline when the message arrived.",
    }),
  };
};

export const templateTicketEscalated = ({
  agentName,
  ticketSubject,
  ticketId,
  ticketUrl /* adminEmail is the recipient; set it on the mail envelope */,
}) => {
  const agent = orFallback(agentName, "Unassigned");
  const subject = orFallback(ticketSubject, "Untitled ticket");
  const cta = dashboardCta("Review ticket", ticketUrl);

  return {
    subject: cleanSubject(`SLA breached: ${subject}`),
    text: textBody(
      [
        "SLA breach alert",
        "",
        "“Deadline ni light teesukunnav… deadline ninnu light teesukoledu.”",
        "",
        `The ticket "${subject}"${ticketId ? ` (#${ticketId})` : ""} passed its SLA deadline and has been escalated.`,
        `Assigned to: ${agent}`,
        "",
        "Please review it and follow up with the customer as soon as possible.",
      ],
      cta,
    ),
    html: layout({
      preheader: `"${subject}" passed its SLA deadline and needs attention.`,
      title: "SLA breached, ticket escalated",
      bodyHtml:
        p(
          "“Deadline ni light teesukunnav… deadline ninnu light teesukoledu.”",
          "font-size: 16px; font-weight: 700;",
        ) +
        p(
          "This ticket passed its SLA deadline and has been escalated. Please review it and follow up with the customer as soon as possible.",
        ) +
        detailsTable([
          detailRow("Subject", esc(subject)),
          ...(ticketId ? [detailRow("Ticket", `#${esc(ticketId)}`)] : []),
          detailRow("Assigned to", esc(agent)),
        ]),
      cta,
    }),
  };
};

// ---------------------------------------------------------------------------
// Account emails
// ---------------------------------------------------------------------------

export const templatePasswordReset = ({
  name,
  resetUrl,
  expiresInMinutes = 15,
}) => {
  const url = safeUrl(resetUrl);
  if (!url)
    throw new Error(
      "templatePasswordReset: resetUrl must be a valid http(s) URL",
    );
  const cta = { label: "Choose a new password", url };

  return {
    subject: `Reset your ${BRAND.name} password`,
    text: textBody(
      [
        greeting(name),
        "",
        "“Prathi password ki oka expiry date untadhi… idhi nee password ki.”",
        "",
        `We received a request to reset the password for your ${BRAND.name} account.`,
        `Use the link below to choose a new password. It expires in ${expiresInMinutes} minutes.`,
        "",
        "If you didn't request this, you can ignore this email. Your password won't change.",
      ],
      cta,
    ),
    html: layout({
      preheader: `Choose a new password. This link expires in ${expiresInMinutes} minutes.`,
      title: "Reset your password",
      bodyHtml:
        p(esc(greeting(name))) +
        p(
          "“Prathi password ki oka expiry date untadhi… idhi nee password ki.”",
          "font-size: 16px; font-weight: 700;",
        ) +
        p(
          `We received a request to reset the password for your ${BRAND.name} account. This link expires in ${strong(`${expiresInMinutes} minutes`)}.`,
        ) +
        p(
          `If the button doesn't work, paste this link into your browser:<br><a class="qd-link" href="${esc(url)}" style="color: ${BRAND.accent}; word-break: break-all; font-size: 13px;">${esc(url)}</a>`,
          "font-size: 13px;",
        ),
      cta,
      footerNote:
        "If you didn't request a password reset, you can ignore this email. Your password won't change.",
    }),
  };
};

export const templateEmailVerification = ({
  name,
  verifyUrl,
  expiresInHours = 24,
}) => {
  const url = safeUrl(verifyUrl);
  if (!url)
    throw new Error(
      "templateEmailVerification: verifyUrl must be a valid http(s) URL",
    );
  const cta = { label: "Verify email address", url };

  return {
    subject: `Verify your ${BRAND.name} email address`,
    text: textBody(
      [
        greeting(name),
        "",
        "“Manalo manaki verification enti anukuntunnava? Just chinna formality anthe. Naaku nee meedha full nammakam undhi, BOSS.”",
        "",
        `Welcome to ${BRAND.name}! Verify your email address to activate your account.`,
        `The link expires in ${expiresInHours} hours.`,
        "",
        `If you didn't create a ${BRAND.name} account, you can ignore this email.`,
      ],
      cta,
    ),
    html: layout({
      preheader: `Verify your email to activate your ${BRAND.name} account.`,
      title: "Verify your email address",
      bodyHtml:
        p(esc(greeting(name))) +
        p(
          "“Manalo manaki verification enti anukuntunnava? Just chinna formality anthe. Naaku nee meedha full nammakam undhi, BOSS.”",
          "font-size: 16px; font-weight: 700;",
        ) +
        p(
          `Welcome to ${BRAND.name}! Verify your email address to activate your account. This link expires in ${strong(`${expiresInHours} hours`)}.`,
        ) +
        p(
          `If the button doesn't work, paste this link into your browser:<br><a class="qd-link" href="${esc(url)}" style="color: ${BRAND.accent}; word-break: break-all; font-size: 13px;">${esc(url)}</a>`,
          "font-size: 13px;",
        ),
      cta,
      footerNote: `If you didn't create a ${BRAND.name} account, you can ignore this email.`,
    }),
  };
};
