/**
 * Database migration runner — applies all .sql files from the migrations/
 * directory in order, skipping any that have already been applied.
 *
 * Usage:
 *   node dist/scripts/run-migrations.js
 *
 * Creates a _migrations tracking table on first run.
 * Idempotent — safe to run multiple times.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { config } from '../config/index.js';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

async function main(): Promise<void> {
  const pool = new pg.Pool({
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    password: config.database.password,
    ssl: process.env.DB_SSL === 'false'
      ? false
      : config.database.host !== 'localhost'
        ? { rejectUnauthorized: false }
        : false,
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });

  try {
    // Ensure tracking table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Get already-applied migrations
    const { rows: applied } = await pool.query<{ filename: string }>(
      'SELECT filename FROM _migrations ORDER BY filename',
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    // Read and sort migration files
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
      const filePath = join(MIGRATIONS_DIR, file);
      const sql = readFileSync(filePath, 'utf-8');

      console.log(`[migrate] Applying: ${file}...`);
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      console.log(`[migrate] Applied: ${file}`);
    }

    console.log(`[migrate] Done. Applied ${pending.length} migration(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});
