-- Mobius4 v4.9.0 Migration
-- Description: Add <container>.maxByteSizePerInstance (mbis)
--
-- Why this is needed
-- -------------------
-- TS-0004:7.4.7.2.1 step 1 requires the Hosting CSE to refuse a <contentInstance> CREATE with
-- NOT_ACCEPTABLE when its content is bigger than the parent <container>'s maxByteSize *or*
-- maxByteSizePerInstance, when either is set. Mobius4 enforced maxByteSize but had no column,
-- no validation and no check for maxByteSizePerInstance at all -- the attribute did not exist.
--
-- ALTER TABLE ... ADD COLUMN with no default is fast and does not rewrite existing rows: every
-- <container> that already exists gets mbis = NULL, meaning "no per-instance limit", which is
-- what it already behaved as. Nothing currently running changes behaviour because of this
-- migration by itself.
--
-- A fresh install does not need this file: db/init.js creates the column directly.

ALTER TABLE cnt ADD COLUMN IF NOT EXISTS mbis INTEGER;
