-- Mobius4 v4.4.0 Migration
-- Branch: performance → master
-- Description: Drop cnt.cin_list, expand lookup.et, add performance indexes
--
-- Safe to run on a live database. All destructive steps are listed explicitly.
-- Run as the DB user that owns the mobius4 schema (same user in config/local.json).
--
-- Usage:
--   psql -U <db_user> -d mobius4 -f db/migrations/v4.4.0.sql

BEGIN;

-- 1. Drop cin_list column from cnt table
--    This column is no longer used by any code path in v4.4.0+.
--    WARNING: existing data in this column will be permanently deleted.
ALTER TABLE cnt DROP COLUMN IF EXISTS cin_list;

-- 2. Expand lookup.et from VARCHAR(14) to VARCHAR(20)
--    Non-destructive: only widens the column, no data loss.
ALTER TABLE lookup ALTER COLUMN et TYPE VARCHAR(20);

-- 3. Performance indexes
--    All use IF NOT EXISTS — safe to re-run on an already-migrated DB.

-- lookup: child-resource queries, expiry cleanup, typed child lookups
CREATE INDEX IF NOT EXISTS idx_lookup_pi    ON lookup (pi);
CREATE INDEX IF NOT EXISTS idx_lookup_et    ON lookup (et);
CREATE INDEX IF NOT EXISTS idx_lookup_pi_ty ON lookup (pi, ty);

-- sub: pi is queried on every CRUD to find active subscriptions
CREATE INDEX IF NOT EXISTS idx_sub_pi ON sub (pi);

-- cnt: child-resource queries
CREATE INDEX IF NOT EXISTS idx_cnt_pi ON cnt (pi);

-- cin: child-resource queries and oldest-CIN eviction (mni/mbs)
CREATE INDEX IF NOT EXISTS idx_cin_pi ON cin (pi);
CREATE INDEX IF NOT EXISTS idx_cin_ct ON cin (ct);

-- ae: child-resource queries
CREATE INDEX IF NOT EXISTS idx_ae_pi ON ae (pi);

COMMIT;
