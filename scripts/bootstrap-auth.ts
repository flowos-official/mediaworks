/**
 * One-shot bootstrap for auth feature:
 *  1. Apply the 3 auth migration SQL files in order via direct Postgres connection
 *  2. Create the first admin user via Supabase Admin API
 *  3. Promote the user to role='admin'
 *
 * Reads DB password and admin password from .env.local.
 * Idempotent: migrations use `if not exists` / `or replace`, admin upsert.
 */

import { readFileSync } from 'fs';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';

const PROJECT_REF = 'sdgxuyigfpmzgxnnoiwf';
const ADMIN_EMAIL = 'jp@flowos.work';

const MIGRATIONS = [
  'supabase/migrations/2026-05-13_auth_schema.sql',
  'supabase/migrations/2026-05-13_auth_rls_loose.sql',
  'supabase/migrations/2026-05-13_auth_storage.sql',
];

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing env: ${name}`);
  }
  return v;
}

async function applyMigrations(password: string): Promise<void> {
  // Session mode pooler — supports DDL safely. Region: ap-northeast-1 (Tokyo)
  const client = new Client({
    host: 'aws-1-ap-northeast-1.pooler.supabase.com',
    port: 5432,
    database: 'postgres',
    user: `postgres.${PROJECT_REF}`,
    password,
    ssl: { rejectUnauthorized: false },
  });

  console.log('[bootstrap] connecting to Postgres pooler...');
  await client.connect();
  console.log('[bootstrap] connected');

  for (const file of MIGRATIONS) {
    const sql = readFileSync(file, 'utf-8');
    console.log(`[bootstrap] applying ${file} (${sql.length} chars)`);
    try {
      await client.query(sql);
      console.log(`[bootstrap]  ✓ ${file}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[bootstrap]  ✗ ${file}: ${msg}`);
      throw e;
    }
  }

  await client.end();
  console.log('[bootstrap] migrations done');
}

async function bootstrapAdmin(): Promise<void> {
  const url = need('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = need('SUPABASE_SERVICE_ROLE_KEY');
  const adminPassword = need('BOOTSTRAP_ADMIN_PASSWORD');

  const sb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`[bootstrap] ensuring admin user ${ADMIN_EMAIL}`);

  // Check if user already exists
  const { data: list } = await sb.auth.admin.listUsers();
  const existing = list.users.find((u) => u.email === ADMIN_EMAIL);

  let userId: string;
  if (existing) {
    console.log(`[bootstrap]  user already exists (id=${existing.id})`);
    userId = existing.id;
  } else {
    const { data, error } = await sb.auth.admin.createUser({
      email: ADMIN_EMAIL,
      password: adminPassword,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new Error(`createUser failed: ${error?.message}`);
    }
    userId = data.user.id;
    console.log(`[bootstrap]  user created (id=${userId})`);
  }

  // Promote to admin (trigger created the row with role='viewer'; we override to admin)
  const { error: updErr } = await sb
    .from('profiles')
    .update({ role: 'admin' })
    .eq('id', userId);

  if (updErr) {
    throw new Error(`promote failed: ${updErr.message}`);
  }
  console.log(`[bootstrap]  role=admin set`);

  // Verify
  const { data: profile } = await sb
    .from('profiles')
    .select('id, email, role')
    .eq('id', userId)
    .single();
  console.log(`[bootstrap]  verified:`, profile);
}

async function main(): Promise<void> {
  const dbPassword = need('SUPABASE_DB_PASSWORD');
  await applyMigrations(dbPassword);
  await bootstrapAdmin();
  console.log('[bootstrap] done');
}

main().catch((e) => {
  console.error('[bootstrap] FATAL:', e);
  process.exit(1);
});
