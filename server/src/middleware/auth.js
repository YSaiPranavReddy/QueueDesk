/**
 * Auth middleware
 * - authenticateToken: verify JWT, attach req.user
 * - requireRole:       RBAC guard — enforce role(s) after authenticateToken
 */
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { createError } from './errorHandler.js';

/**
 * Verifies the access token from the Authorization header.
 * Attaches decoded payload to req.user on success.
 */
export const authenticateToken = (req, _res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) return next(createError(401, 'No access token provided'));

  try {
    const payload = jwt.verify(token, config.jwt.accessSecret);
    req.user = payload; // { id, email, role, iat, exp }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return next(createError(401, 'Access token expired'));
    return next(createError(401, 'Invalid access token'));
  }
};

/**
 * Role-based access control guard.
 * Must be used AFTER authenticateToken.
 *
 * @param {...string} roles - Allowed roles (e.g. 'agent', 'admin')
 * @example router.get('/claim', authenticateToken, requireRole('agent', 'admin'), handler)
 */
export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(createError(401, 'Unauthenticated'));
  if (!roles.includes(req.user.role)) {
    return next(createError(403, `Forbidden: requires role ${roles.join(' or ')}`));
  }
  next();
};

/**
 * Socket.IO auth middleware — verifies token on WebSocket handshake.
 * Applied in socket/index.js before any event handlers.
 *
 * @param {import('socket.io').Socket} socket
 * @param {Function} next
 */
export const authenticateSocket = (socket, next) => {
  // Client sends token via query param (see useSocket hook)
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('No token provided on socket handshake'));

  try {
    const payload = jwt.verify(token, config.jwt.accessSecret);
    socket.user = payload; // attach to socket for use in event handlers
    next();
  } catch {
    next(new Error('Invalid or expired socket token'));
  }
};
