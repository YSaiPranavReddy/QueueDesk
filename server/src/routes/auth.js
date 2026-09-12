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
import { findUserByEmail, findUserById, createUser } from '../models/user.js';
import { query } from '../config/db.js';

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
 * POST /api/auth/register
 * Body: { name, email, password, role? }
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

    const accessToken = signAccessToken(user);
    await issueRefreshToken(res, user);

    res.status(201).json({
      success: true,
      accessToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Rate-limited: 10 req / 15 min per IP
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
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/refresh
 * Reads refreshToken from httpOnly cookie.
 * Returns a new access token (+ rotates the refresh token).
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
 * POST /api/auth/logout
 * Revokes the refresh token from the cookie.
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

router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role, notify_email FROM users WHERE id = $1`,
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

export default router;
