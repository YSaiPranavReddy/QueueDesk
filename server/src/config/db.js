import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error', err);
});

/**
 * Execute a parameterised query.
 * @param {string} text  - SQL query string
 * @param {any[]}  params - Query parameters
 */
export const query = (text, params) => pool.query(text, params);

/**
 * Get a client from the pool (for transactions).
 * Always release the client in a finally block.
 */
export const getClient = () => pool.connect();

export default pool;
