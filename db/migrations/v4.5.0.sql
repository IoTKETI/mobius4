-- Mobius4 v4.5.0 Migration
-- Branch: feat/flexcontainer → master
-- Description: Add flx table for <flexContainer> (ty=28) and its indexes
--
-- Safe to run on a live database. Non-destructive: only adds a new table and indexes.
-- Run as the DB user that owns the mobius4 schema (same user in config/local.json).
--
-- Usage:
--   psql -U <db_user> -d mobius4 -f db/migrations/v4.5.0.sql
--
-- Note: db/init.js creates this table with CREATE TABLE IF NOT EXISTS on every boot, so a
-- restarted instance picks it up automatically. This file exists for deployments that
-- migrate the schema ahead of the code, and to document the change.

BEGIN;

-- 1. flx table for <flexContainer>
--    "or" (ontologyRef) is quoted because OR is a reserved SQL keyword.
--    "custom" holds the [customAttribute] set. Its members are defined by the document
--    referenced by cnd, so they are unknown at schema-design time and cannot be columns.
--    "ek" stores the envelope key as received (e.g. 'sc:parkingBlock'); TS-0004:7.4.37.1
--    permits a specialization to use a targetNamespace other than m2m:, and the original
--    key has to be replayed on RETRIEVE.
-- Column widths mirror the config `length` values db/init.js interpolates
-- (ri_max 30, structured_res_id 255, str_token 255, timestamp 20).
CREATE TABLE IF NOT EXISTS flx (
    ri VARCHAR(30) PRIMARY KEY,
    ty INTEGER NOT NULL DEFAULT 28,
    sid VARCHAR(255) NOT NULL UNIQUE,
    cr VARCHAR(255),
    int_cr VARCHAR(255),
    rn VARCHAR(255) NOT NULL,
    pi VARCHAR(30),
    et VARCHAR(20) NOT NULL,
    ct VARCHAR(20) NOT NULL,
    lt VARCHAR(20) NOT NULL,
    acpi VARCHAR(255)[],
    lbl VARCHAR(255)[],
    st INTEGER DEFAULT 0,
    loc GEOMETRY(GEOMETRY, 4326),
    cnd VARCHAR(255) NOT NULL,
    cs INTEGER DEFAULT 0,
    nl VARCHAR(255),
    "or" VARCHAR(255),
    ek VARCHAR(255) NOT NULL,
    custom JSONB
);

-- 2. Indexes
--    All use IF NOT EXISTS — safe to re-run on an already-migrated DB.

-- flx: child-resource queries, containerDefinition discovery filter, and a GIN index so
-- custom attributes stay queryable as JSONB
CREATE INDEX IF NOT EXISTS idx_flx_pi     ON flx (pi);
CREATE INDEX IF NOT EXISTS idx_flx_cnd    ON flx (cnd);
CREATE INDEX IF NOT EXISTS idx_flx_custom ON flx USING GIN (custom);

COMMIT;
