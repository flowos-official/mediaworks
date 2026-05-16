/**
 * Check what kind of relation each "view-name" actually is in the public schema,
 * and (if a view) whether security_invoker is set.
 */

import { Client } from 'pg';

const PROJECT_REF = 'sdgxuyigfpmzgxnnoiwf';

const NAMES = [
  'product_summaries',
  'monthly_summaries',
  'category_summaries',
  'annual_summaries',
];

async function main(): Promise<void> {
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!password) {
    console.error('SUPABASE_DB_PASSWORD is required');
    process.exit(1);
  }

  const client = new Client({
    host: 'aws-1-ap-northeast-1.pooler.supabase.com',
    port: 5432,
    database: 'postgres',
    user: `postgres.${PROJECT_REF}`,
    password,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  const res = await client.query(
    `select relname,
            relkind,
            case relkind
              when 'r' then 'table'
              when 'v' then 'view'
              when 'm' then 'materialized view'
              else relkind::text
            end as kind,
            coalesce((
              select option_value
              from pg_options_to_table(reloptions)
              where option_name='security_invoker'
            ), 'unset') as security_invoker
     from pg_class
     where relnamespace=(select oid from pg_namespace where nspname='public')
       and relname = any($1::text[])
     order by relname`,
    [NAMES],
  );
  console.table(res.rows);
  await client.end();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
