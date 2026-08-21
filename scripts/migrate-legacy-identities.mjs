#!/usr/bin/env node
/** Operator-only, one-time identity cutover. Dry-run unless --apply is present. */
import { Pool } from 'pg';
import { pgConnectionConfig } from '../platform/src/core/pgurl.js';
import {
  createLegacyCutoverDb, createSupabaseLegacyAdmin, cutoverLegacyIdentities,
} from '../platform/src/modules/auth/legacy-cutover.js';

const apply = process.argv.includes('--apply');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (apply && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required with --apply');
}

const pool = new Pool({ ...pgConnectionConfig(process.env.DATABASE_URL), max: 1 });
const db = createLegacyCutoverDb(pool);

try {
  const provider = apply ? createSupabaseLegacyAdmin({
    baseUrl: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  }) : null;
  const report = await cutoverLegacyIdentities({ db, provider, apply });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.blockingCount) process.exitCode = 1;
} finally {
  await pool.end();
}
