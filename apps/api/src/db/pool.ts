import { Pool } from 'pg';

// Single shared connection pool. In production this connects as the `simorgh_api` role (see
// db/migrations/013_roles_and_grants.sql) which has no access to site_location_restricted at all —
// enforced at the database layer, not just by this app choosing not to query it.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 10),
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] unexpected pool error', err);
});
