/**
 * Aangan's tables live in their own Postgres schema so the app can share a Supabase project with
 * other applications. The schema must be listed under Data API → Exposed schemas.
 */
export const DB_SCHEMA = process.env.SUPABASE_DB_SCHEMA?.trim() || "aangan";
