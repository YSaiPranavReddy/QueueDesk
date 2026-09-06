import { query } from './src/config/db.js';

async function runMigration() {
  console.log('Running migration...');
  try {
    await query(`ALTER TABLE tickets ADD COLUMN waiting_on_customer BOOLEAN NOT NULL DEFAULT false;`);
    console.log('Migration successful: Added waiting_on_customer column.');
  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log('Column already exists.');
    } else {
      console.error('Migration failed:', err);
    }
  }
  process.exit(0);
}

runMigration();
