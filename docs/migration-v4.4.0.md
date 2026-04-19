# DB Migration Guide — v4.4.0

This guide covers the database schema changes introduced in Mobius4 **v4.4.0** (performance branch → master).

## Changes Overview

| # | Table | Change | Impact |
|---|-------|--------|--------|
| 1 | `cnt` | Drop `cin_list` column | Destructive — data lost |
| 2 | `lookup` | Widen `et` column `VARCHAR(14)` → `VARCHAR(20)` | Non-destructive |
| 3 | Multiple | Add 8 performance indexes | Non-destructive |

## Prerequisites

- PostgreSQL v17 with PostGIS
- `psql` CLI accessible
- DB user with `ALTER TABLE` and `CREATE INDEX` privileges (same as `config/local.json → db.user`)
- **Backup your database before running** (see below)

## Step 1 — Backup

```bash
pg_dump -U <db_user> -d mobius4 -F c -f mobius4_backup_$(date +%Y%m%d).dump
```

Verify the backup is readable:
```bash
pg_restore --list mobius4_backup_$(date +%Y%m%d).dump | head -20
```

## Step 2 — Stop Mobius4

Stop the server before migration to prevent writes during schema changes.

```bash
# If using PM2:
pm2 stop mobius4

# If running directly:
# Send SIGTERM or Ctrl+C — Mobius4 performs graceful shutdown
```

## Step 3 — Run the Migration Script

```bash
psql -U <db_user> -d mobius4 -f db/migrations/v4.4.0.sql
```

Expected output:

```
BEGIN
ALTER TABLE
ALTER TABLE
CREATE INDEX
CREATE INDEX
CREATE INDEX
CREATE INDEX
CREATE INDEX
CREATE INDEX
CREATE INDEX
CREATE INDEX
COMMIT
```

If any step fails, the transaction rolls back automatically (all statements are wrapped in `BEGIN`/`COMMIT`).

## Step 4 — Verify

```bash
psql -U <db_user> -d mobius4 -c "\d cnt"
```

Confirm `cin_list` column is **absent**.

```bash
psql -U <db_user> -d mobius4 -c "\d lookup"
```

Confirm `et` column type is `character varying(20)`.

```bash
psql -U <db_user> -d mobius4 -c "\di idx_*"
```

Confirm all 8 indexes are listed.

## Step 5 — Deploy v4.4.0 and Restart

```bash
git pull origin master   # or deploy the new build

# If using PM2:
pm2 start mobius4

# If running directly:
node mobius4.js
```

## Rollback

If you need to revert to v4.3.x schema:

```sql
BEGIN;

-- Restore cin_list (data cannot be recovered — column will be empty)
ALTER TABLE cnt ADD COLUMN IF NOT EXISTS cin_list VARCHAR(512)[];

-- Narrow et back (safe only if no value exceeds 14 chars)
ALTER TABLE lookup ALTER COLUMN et TYPE VARCHAR(14);

-- Drop the new indexes
DROP INDEX IF EXISTS idx_lookup_pi;
DROP INDEX IF EXISTS idx_lookup_et;
DROP INDEX IF EXISTS idx_lookup_pi_ty;
DROP INDEX IF EXISTS idx_sub_pi;
DROP INDEX IF EXISTS idx_cnt_pi;
DROP INDEX IF EXISTS idx_cin_pi;
DROP INDEX IF EXISTS idx_cin_ct;
DROP INDEX IF EXISTS idx_ae_pi;

COMMIT;
```

> **Note:** `cin_list` data lost during the forward migration cannot be recovered from the rollback. Restore from the backup if the original data is needed.

## Notes on Large `cin` Tables

If your `cin` table is large (millions of rows), building `idx_cin_pi` and `idx_cin_ct` may take time and lock the table briefly. To minimize impact, build them concurrently **outside the transaction**:

```sql
-- Run these separately, NOT inside a transaction block
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cin_pi ON cin (pi);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cin_ct ON cin (ct);
```

Then run the main migration script with those two index statements commented out.
