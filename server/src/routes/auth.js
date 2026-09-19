/**
 * Auth routes — M1.T3 (full implementation) + M1.T6 (rate limiter)
 *
 * POST /api/auth/register  — create account
 * POST /api/auth/login     — issue access + refresh tokens
 * POST /api/auth/refresh   — rotate refresh token (reads httpOnly cookie)
 * POST /api/auth/logout    — revoke refresh token
 * GET  /api/auth/me        — return current user from access token
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import crypto from 'crypto';

import { config } from '../config/index.js';
import { createError } from '../middleware/errorHandler.js';
import { authenticateToken } from '../middleware/auth.js';
import { findUserByEmail, findUserById, createUser, markUserEmailVerified } from '../models/user.js';
import { query } from '../config/db.js';
import redis from '../config/redis.js';
import { notificationQueue } from '../workers/notificationWorker.js';
import { templatePasswordReset, templateEmailVerification } from '../utils/emailTemplates.js';

const router = Router();

// ─── Rate limiter — M1.T6 ────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 attempts per IP per window
  standardHeaders: true,     // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Issue a short-lived access token */
const signAccessToken = (user) =>
  jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessExpiry }
  );

/** Issue a long-lived refresh token (opaque random bytes) */
const generateRefreshToken = () => crypto.randomBytes(64).toString('hex');

/**
 * Store refresh token hash in DB and set the httpOnly cookie on the response.
 * - The raw token is set in the cookie (sent by the browser automatically)
 * - Only a SHA-256 hash is stored in the DB (fast O(1) lookups, resistant to leaks)
 */
const issueRefreshToken = async (res, user) => {
  const rawToken = generateRefreshToken();
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt]
  );

  res.cookie('refreshToken', rawToken, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: config.isProd ? 'none' : 'lax', // 'none' required for cross-origin (Vercel → Render)
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/api/auth', // Scoped — only sent to /api/auth routes
  });
};

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [customer, agent]
 *     responses:
 *       201:
 *         description: Successfully registered
 *       400:
 *         description: Validation error
 *       409:
 *         description: Email already in use
 */
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, role = 'customer' } = req.body;

    if (!name || !email || !password) return next(createError(400, 'name, email and password are required'));
    if (!['customer', 'agent'].includes(role)) return next(createError(400, 'role must be customer or agent'));
    if (password.length < 8) return next(createError(400, 'Password must be at least 8 characters'));

    const existing = await findUserByEmail(email);
    if (existing) return next(createError(409, 'An account with that email already exists'));

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createUser({ email, passwordHash, name, role });

    // Send verification email (fire-and-forget — don't block registration)
    try {
      const rawToken  = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      await redis.setex(`email_verify:${tokenHash}`, 24 * 60 * 60, user.id); // 24h TTL
      const verifyUrl = `${config.frontendUrl}/verify-email?token=${rawToken}`;
      const template = templateEmailVerification({ name: user.name, verifyUrl });
      await notificationQueue.add('email', {
        to: user.email,
        subject: template.subject,
        text: template.text,
        html: template.html,
        userId: user.id,
        eventType: 'email_verification',
      }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
    } catch (emailErr) {
      console.error('[Auth] Failed to send verification email:', emailErr.message);
    }

    const accessToken = signAccessToken(user);
    await issueRefreshToken(res, user);

    res.status(201).json({
      success: true,
      accessToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, email_verified: false },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Log in to the application
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Successfully logged in
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return next(createError(400, 'email and password are required'));

    const user = await findUserByEmail(email);

    // Constant-time comparison even on "user not found" (prevent user enumeration via timing)
    const dummyHash = '$2a$12$invalidhashfortimingnormalization000000000000000000000';
    const passwordHash = user?.password_hash ?? dummyHash;
    const valid = await bcrypt.compare(password, passwordHash);

    if (!user || !valid) return next(createError(401, 'Invalid email or password'));

    const accessToken = signAccessToken(user);
    await issueRefreshToken(res, user);

    res.json({
      success: true,
      accessToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, email_verified: user.email_verified ?? false },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh access token
 *     tags: [Auth]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Token successfully refreshed
 *       401:
 *         description: No valid refresh token provided
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const rawToken = req.cookies?.refreshToken;
    if (!rawToken) return next(createError(401, 'No refresh token'));

    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Direct O(1) lookup
    const { rows } = await query(
      `SELECT rt.*, u.id as uid, u.email, u.name, u.role
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.revoked = false AND rt.expires_at > NOW()`,
      [tokenHash]
    );

    const matchedRow = rows[0];
    if (!matchedRow) return next(createError(401, 'Invalid or expired refresh token'));

    // Revoke used token (rotation — prevents replay)
    await query('UPDATE refresh_tokens SET revoked = true WHERE id = $1', [matchedRow.id]);

    const user = { id: matchedRow.uid, email: matchedRow.email, name: matchedRow.name, role: matchedRow.role };
    const accessToken = signAccessToken(user);
    await issueRefreshToken(res, user);

    res.json({ success: true, accessToken });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Log out of the application
 *     tags: [Auth]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Successfully logged out
 */
router.post('/logout', async (req, res, next) => {
  try {
    const rawToken = req.cookies?.refreshToken;

    if (rawToken) {
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      await query(
        'UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1 AND revoked = false',
        [tokenHash]
      );
    }

    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.json({ success: true, message: 'Logged out' });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get current authenticated user
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Returns current user data
 *       401:
 *         description: Unauthorized
 */
router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role, notify_email, email_verified FROM users WHERE id = $1`,
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return next(createError(404, 'User not found'));
    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/auth/me/preferences
 * Toggle email notifications
 */
router.patch('/me/preferences', authenticateToken, async (req, res, next) => {
  try {
    const { notify_email } = req.body;
    if (typeof notify_email !== 'boolean') {
      return next(createError(400, 'notify_email must be a boolean'));
    }

    await query(
      `UPDATE users SET notify_email = $1 WHERE id = $2`,
      [notify_email, req.user.id]
    );

    res.json({ success: true, notify_email });
  } catch (err) {
    next(err);
  }
});


// ─── Email Verification ───────────────────────────────────────────────────────

const resendVerifyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { success: false, message: 'Too many verification requests. Try again in a minute.' },
});

/**
 * GET /api/auth/verify-email?token=...
 * Called when user clicks the link in their verification email.
 */
router.get('/verify-email', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return next(createError(400, 'Verification token is required'));

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const userId    = await redis.get(`email_verify:${tokenHash}`);

    if (!userId) {
      return next(createError(400, 'Invalid or expired verification link. Please request a new one.'));
    }

    await markUserEmailVerified(userId);
    await redis.del(`email_verify:${tokenHash}`);

    res.json({ success: true, message: 'Email verified successfully! You can now log in.' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/resend-verification
 * Resend a new verification email (for logged-in unverified users).
 */
router.post('/resend-verification', authenticateToken, resendVerifyLimiter, async (req, res, next) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return next(createError(404, 'User not found'));
    if (user.email_verified) {
      return res.json({ success: true, message: 'Your email is already verified.' });
    }

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    await redis.setex(`email_verify:${tokenHash}`, 24 * 60 * 60, user.id);
    const verifyUrl = `${config.frontendUrl}/verify-email?token=${rawToken}`;
    const template  = templateEmailVerification({ name: user.name, verifyUrl });

    await notificationQueue.add('email', {
      to: user.email,
      subject: template.subject,
      text: template.text,
      html: template.html,
      userId: user.id,
      eventType: 'email_verification',
    }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });

    res.json({ success: true, message: 'Verification email sent! Please check your inbox.' });
  } catch (err) {
    next(err);
  }
});

// ─── Forgot / Reset Password ──────────────────────────────────────────────────

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { success: false, message: 'Too many reset requests. Please try again in an hour.' },
});

/**
 * @swagger
 * /api/auth/forgot-password:
 *   post:
 *     summary: Request a password reset link
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Reset link sent (always 200 to prevent email enumeration)
 */
router.post('/forgot-password', forgotLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return next(createError(400, 'Email is required'));

    // Always respond 200 regardless of whether the email exists (prevents enumeration)
    const user = await findUserByEmail(email.toLowerCase().trim());
    if (!user) {
      return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
    }

    // Generate a secure random token and store hashed version in Redis (15 min TTL)
    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const redisKey  = `pwd_reset:${tokenHash}`;

    await redis.setex(redisKey, 15 * 60, user.id); // 15 minutes

    // Build the reset URL
    const resetUrl = `${config.frontendUrl}/reset-password?token=${rawToken}`;

    // Send email via Resend through notification queue
    const template = templatePasswordReset({ name: user.name, resetUrl });

    await notificationQueue.add('email', {
      to: user.email,
      subject: template.subject,
      text: template.text,
      html: template.html,
      userId: user.id,
      eventType: 'password_reset',
    }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });

    res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/auth/reset-password:
 *   post:
 *     summary: Reset password using the token from the email link
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, password]
 *             properties:
 *               token:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password updated successfully
 *       400:
 *         description: Invalid or expired token
 */
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return next(createError(400, 'Token and new password are required'));
    if (password.length < 8) return next(createError(400, 'Password must be at least 8 characters'));

    // Look up the hashed token in Redis
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const redisKey  = `pwd_reset:${tokenHash}`;
    const userId    = await redis.get(redisKey);

    if (!userId) {
      return next(createError(400, 'Invalid or expired reset link. Please request a new one.'));
    }

    // Hash the new password and update
    const passwordHash = await bcrypt.hash(password, 12);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, userId]);

    // Invalidate the token immediately so it can only be used once
    await redis.del(redisKey);

    // Revoke all existing refresh tokens for this user (force re-login everywhere)
    await query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);

    res.json({ success: true, message: 'Password reset successfully. Please log in with your new password.' });
  } catch (err) {
    next(err);
  }
});

export default router;
