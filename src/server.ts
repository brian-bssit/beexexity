import { EventEmitter } from 'events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import app from './app.js';
import { config } from './config/index.js';
import { pool } from './config/database.js';

/**
 * HTTP server startup.
 * Listens on the port defined in config (defaults to 3000).
 *
 * Raise EventEmitter limit — sequential reasoning creates many concurrent
 * Bedrock calls (planner + N steps with retries + synthesis), each adding
 * HTTP close listeners. Default 10 is too low.
 */
EventEmitter.defaultMaxListeners = 50;

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/**
 * Auto-apply pending database migrations at startup.
 * Idempotent — safe to run on every deploy. Fail-open: logs errors but
 * never prevents server from starting.
 */
async function runMigrations(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows: applied } = await pool.query<{ filename: string }>(
      'SELECT filename FROM _migrations ORDER BY filename',
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('[migrate] No migration files found.');
      return;
    }

    const pending = files.filter((f) => !appliedSet.has(f));
    if (pending.length === 0) {
      console.log(`[migrate] All ${files.length} migrations already applied.`);
      return;
    }

    console.log(`[migrate] Found ${files.length} total, ${pending.length} pending.`);
    for (const file of pending) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      console.log(`[migrate] Applying: ${file}...`);
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      console.log(`[migrate] Applied: ${file}`);
    }
    console.log(`[migrate] Done. Applied ${pending.length} migration(s).`);
  } catch (err) {
    console.error('[migrate] Migration error (server will continue):', (err as Error).message);
  }
}

const port = config.server.port;

runMigrations().then(() => {
  app.listen(port, () => {
    console.log(`[Server] Siap Ditanya running on port ${port}`);
    console.log(`[Server] Region: ${config.aws.region}`);
  });
});
