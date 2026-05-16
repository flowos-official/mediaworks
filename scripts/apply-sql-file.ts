/**
 * Apply a single SQL file to the live Supabase Postgres via session-mode pooler.
 * Usage: tsx scripts/apply-sql-file.ts <path-to-sql>
 */

import { readFileSync } from 'fs';
import { Client } from 'pg';

const PROJECT_REF = 'sdgxuyigfpmzgxnnoiwf';

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: tsx scripts/apply-sql-file.ts <file.sql>');
    process.exit(1);
  }

  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!password) {
    console.error('SUPABASE_DB_PASSWORD is required');
    process.exit(1);
  }

  const sql = readFileSync(file, 'utf-8');
  console.log(`[apply] connecting to pooler...`);

  const client = new Client({
    host: 'aws-1-ap-northeast-1.pooler.supabase.com',
    port: 5432,
    database: 'postgres',
    user: `postgres.${PROJECT_REF}`,
    password,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log(`[apply] applying ${file} (${sql.length} chars)`);

  try {
    await client.query(sql);
    console.log(`[apply] ✓ done`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('[apply] FATAL:', e);
  process.exit(1);
});
