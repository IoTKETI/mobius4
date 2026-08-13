-- Mobius4 v4.15.0 Migration
-- Description: Rename mrp.mid to mrp.mmd_list
--
-- Why this is needed
-- -------------------
-- The <modelRepo> table was copied from <group>'s table definition and kept the column name
-- "mid" (group uses it for memberIDs), but models/mrp-model.js's Sequelize definition has
-- always called the same column "mmd_list" (the list of <mlModel> children, TR-0071). Every
-- INSERT/UPDATE Sequelize builds for the mrp table therefore references a column that does not
-- exist, so every <modelRepo> CREATE fails with RSC 4000. Found by
-- scripts/probe-capabilities.js (feat/tr0071-ai-ml-tests, ty 101 CREATE).
--
-- The sibling resources that hold the same kind of child-list column do not have this problem:
-- mdp.dpm_list and dts.dsf_list already agree between db/init.js and their models.
--
-- ALTER TABLE ... RENAME COLUMN is a metadata-only change in PostgreSQL -- it does not rewrite
-- the table and does not touch existing data, it only makes the column addressable under the
-- name Sequelize already expects. Since CREATE has always failed for this table, there is no
-- row on any existing deployment with a non-null "mid" to lose.
--
-- A fresh install does not need this file: db/init.js creates the column as mmd_list directly.

ALTER TABLE mrp RENAME COLUMN mid TO mmd_list;

-- Second change in this release
-- ------------------------------
-- Description: Drop mrp.mmd_list, mdp.dpm_list and dts.dsf_list
--
-- <mlModel>, <modelDeployment> and <datasetFragment> were tracked in their parent's list column
-- (mmd_list/dpm_list/dsf_list) purely to resolve <latest>/<oldest> by array position, and
-- mmd_list additionally picked the eviction victim for maxNumberOfModels. <container> used to
-- work the same way with cin_list and no longer does (see the "not obsolete" comment on
-- find_edge_cin in cse/resources/cnt.js): a list returns whatever was pushed, including children
-- the CSE has already declared expired, so <latest> could keep serving expired content. This
-- release moves all three families onto the same query-based lookup <container> uses
-- (find_edge_mmd/find_edge_dpm/find_edge_dsf in cse/resources/mmd.js, dpm.js, dsf.js), so the
-- list columns are now dead: nothing in cse/, models/ or db/ reads them.
--
-- The row directly above this comment (the mmd_list rename) still has to run first on an
-- existing database, which is why this is appended to the same file rather than assuming the
-- column is already named mmd_list.
--
-- No existing deployment can have live data to lose here: <modelRepo> CREATE was broken (the
-- "mid" vs "mmd_list" mismatch fixed above) on every deployment until this same release, so no
-- row could have accumulated an mmd_list entry, and the same is true of mdp.dpm_list and
-- dts.dsf_list -- their only writers were the mrp-family sibling code paths added alongside
-- mrp's, in the same commit history, never separately released.
--
-- mrp.mnmo (maxNumberOfModels) and mrp.mbmo (maxByteOfModels) are optional per TR-0071:7.1.2.1
-- (multiplicity 0..1), but cse/resources/mrp.js used to store an omitted value as 0 rather than
-- NULL, which made update_parent_mrp's `cnmo > mnmo` guard (cse/resources/mmd.js) fire on the
-- very first <mlModel> insert and evict the model just created. The create path now stores NULL
-- for an omitted mnmo/mbmo; for the same "no live data" reason as above, no existing row can
-- hold the old 0 default, so there is nothing to backfill.

ALTER TABLE mrp DROP COLUMN IF EXISTS mmd_list;
ALTER TABLE mdp DROP COLUMN IF EXISTS dpm_list;
ALTER TABLE dts DROP COLUMN IF EXISTS dsf_list;
