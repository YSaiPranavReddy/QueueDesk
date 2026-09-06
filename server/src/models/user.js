/**
 * User model — DB query functions for the users table.
 * All queries go through the pool helper, never raw SQL in routes.
 */
import { query } from '../config/db.js';

/**
 * Find a user by their email address.
 * @param {string} email
 * @returns {Promise<object|null>}
 */
export const findUserByEmail = async (email) => {
  const { rows } = await query(
    'SELECT * FROM users WHERE email = $1 LIMIT 1',
    [email.toLowerCase().trim()]
  );
  return rows[0] || null;
};

/**
 * Find a user by ID.
 * @param {string} id - UUID
 * @returns {Promise<object|null>}
 */
export const findUserById = async (id) => {
  const { rows } = await query(
    'SELECT id, email, name, role, notify_email, created_at FROM users WHERE id = $1',
    [id]
  );
  return rows[0] || null;
};

/**
 * Create a new user.
 * @param {{ email: string, passwordHash: string, name: string, role: string }} data
 * @returns {Promise<object>} Created user (no password_hash)
 */
export const createUser = async ({ email, passwordHash, name, role = 'customer' }) => {
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, name, role, created_at`,
    [email.toLowerCase().trim(), passwordHash, name, role]
  );
  return rows[0];
};

/**
 * List all agents with their current status (online status from Redis, not DB).
 * Returns DB fields only — Redis availability merged in the service layer.
 */
export const findAllAgents = async () => {
  const { rows } = await query(
    `SELECT id, name, email, created_at
     FROM users
     WHERE role = 'agent'
     ORDER BY name ASC`
  );
  return rows;
};
