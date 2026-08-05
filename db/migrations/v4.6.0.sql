-- Mobius4 v4.6.0 Migration
-- Branch: fix/admin-identity-required → master
-- Description: Replace the admin identity recorded in the database
--
-- Why this is needed
-- ------------------
-- Until v4.6.0, config/default.json shipped cse.admin = 'SM'. That identity grants
-- unconditional access to every resource — cse/hostingCSE.js returns access granted before any
-- <accessControlPolicy> is consulted — and it applies over plain HTTP as well as TLS. Any
-- deployment that never overrode it could be fully controlled by anyone who could reach the
-- port and send "X-M2M-Origin: SM".
--
-- v4.6.0 removes the default and refuses to start until cse.admin is set. But changing the
-- configuration is only half the migration: db/init.js writes the admin identity into the
-- database when it first creates the CSEBase and the default <accessControlPolicy>, and it
-- never rewrites them ("default acp already exists, skipped"). So the old identity survives in:
--
--   * acp.pvs        — the default ACP's self-privileges (acop 63) still name the old admin,
--                      so the new admin cannot modify that ACP through the standard path
--   * <table>.cr     — creator, on every resource the old admin created
--   * <table>.int_cr — internal creator, used by access control when a resource has no acpi
--   * lookup.cr / lookup.int_cr — the same two, mirrored in the lookup table
--
-- Run this after setting the new cse.admin in config/local.json and before restarting.
--
-- Usage:
--   1. Fill in new_admin in BOTH DO blocks below (and old_admin, if it was not 'SM').
--   2. psql -U <db_user> -d mobius4 -f db/migrations/v4.6.0.sql
--
-- The whole migration is one transaction: it either applies completely or not at all.
-- It is idempotent — re-running it after a successful run matches nothing and changes nothing.

BEGIN;

DO $$
DECLARE
    -- ─── EDIT THESE TWO ────────────────────────────────────────────────────────
    old_admin TEXT := 'SM';   -- the identity this deployment has been using
    new_admin TEXT := '';     -- EDIT: the identity now set in config/local.json
    -- ───────────────────────────────────────────────────────────────────────────

    -- Every table carrying a creator column. cin has cr but no int_cr.
    tables_with_both TEXT[] := ARRAY[
        'lookup', 'acp', 'sub', 'cnt', 'flx', 'grp', 'ae', 'csr',
        'mrp', 'mmd', 'mdp', 'dpm', 'dsp', 'dts', 'dsf'
    ];
    t TEXT;
    touched BIGINT;
    total BIGINT := 0;
BEGIN
    -- The sentinel is the empty string rather than a placeholder word, so that a global
    -- find/replace of the placeholder cannot rewrite this check along with the declaration.
    IF new_admin = '' OR new_admin = old_admin THEN
        RAISE EXCEPTION
            'Set new_admin to the identity you configured in cse.admin, and make it different from old_admin (%).',
            old_admin;
    END IF;

    -- 1. Resource tables: creator and internal creator.
    --    Tables are skipped when absent rather than failing the migration: a database that
    --    predates a resource type (flx arrived in v4.5.0, the AI/ML tables later still) simply
    --    does not have them yet, and db/init.js creates them on the next boot.
    FOREACH t IN ARRAY tables_with_both LOOP
        CONTINUE WHEN to_regclass('public.' || quote_ident(t)) IS NULL;
        EXECUTE format('UPDATE %I SET cr = $2 WHERE cr = $1', t) USING old_admin, new_admin;
        GET DIAGNOSTICS touched = ROW_COUNT; total := total + touched;
        EXECUTE format('UPDATE %I SET int_cr = $2 WHERE int_cr = $1', t) USING old_admin, new_admin;
        GET DIAGNOSTICS touched = ROW_COUNT; total := total + touched;
    END LOOP;

    -- 2. contentInstance has cr only
    IF to_regclass('public.cin') IS NOT NULL THEN
        UPDATE cin SET cr = new_admin WHERE cr = old_admin;
        GET DIAGNOSTICS touched = ROW_COUNT; total := total + touched;
    END IF;

    -- 3. <accessControlPolicy> privileges. The old admin can appear in any acr entry of pv or
    --    pvs, not just the default ACP's self-privileges, so every accessControlOriginator
    --    list is rewritten. jsonb_set cannot reach into an array element by value, so the acr
    --    array is rebuilt with the acor list mapped.
    UPDATE acp SET pvs = jsonb_set(pvs, '{acr}', (
        SELECT jsonb_agg(
            CASE WHEN rule -> 'acor' ? old_admin
                 THEN jsonb_set(rule, '{acor}', (
                     SELECT jsonb_agg(CASE WHEN v::text = to_jsonb(old_admin)::text
                                           THEN to_jsonb(new_admin) ELSE v END)
                     FROM jsonb_array_elements(rule -> 'acor') AS v))
                 ELSE rule END)
        FROM jsonb_array_elements(pvs -> 'acr') AS rule))
    WHERE pvs -> 'acr' @> jsonb_build_array(jsonb_build_object('acor', jsonb_build_array(old_admin)))
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(pvs -> 'acr') AS r WHERE r -> 'acor' ? old_admin);
    GET DIAGNOSTICS touched = ROW_COUNT; total := total + touched;

    UPDATE acp SET pv = jsonb_set(pv, '{acr}', (
        SELECT jsonb_agg(
            CASE WHEN rule -> 'acor' ? old_admin
                 THEN jsonb_set(rule, '{acor}', (
                     SELECT jsonb_agg(CASE WHEN v::text = to_jsonb(old_admin)::text
                                           THEN to_jsonb(new_admin) ELSE v END)
                     FROM jsonb_array_elements(rule -> 'acor') AS v))
                 ELSE rule END)
        FROM jsonb_array_elements(pv -> 'acr') AS rule))
    WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(pv -> 'acr') AS r WHERE r -> 'acor' ? old_admin);
    GET DIAGNOSTICS touched = ROW_COUNT; total := total + touched;

    RAISE NOTICE 'admin identity migrated: % -> % (% rows)', old_admin, new_admin, total;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Part 2: create the admin <accessControlPolicy> and attach it to existing resources
--
-- v4.6.0 also removes the administrator short-circuit in cse/hostingCSE.js, which used to
-- grant every operation before any policy was read. The administrator now gets its privileges
-- the way oneM2M expresses them, through an <accessControlPolicy>. db/init.js creates that
-- policy on a fresh database; this part creates it on an existing one and adds it to the
-- resources that already carry an acpi.
--
-- Resources with an EMPTY acpi are deliberately left alone. Access control falls back to
-- comparing the originator with the recorded creator when acpi is empty (Case D in
-- access_decision); giving such a resource an acpi would switch it to policy evaluation and
-- its creator would lose the update and delete rights it has today. The administrator's reach
-- into those resources therefore now follows the same creator rule as everyone else.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
    new_admin  TEXT := '';                 -- EDIT: same value as in Part 1
    csebase_rn TEXT := 'Mobius';           -- config.cse.csebase_rn
    acp_rn     TEXT := 'cb_admin_acp';     -- config.cb.admin_acp.rn

    acp_sid    TEXT;
    acp_ri     TEXT;
    cb_ri      TEXT;
    et         TEXT;
    now_ts     TEXT;
    privileges JSONB;
    t          TEXT;
    touched    BIGINT;
    total      BIGINT := 0;
    tables_with_acpi TEXT[] := ARRAY[
        'acp', 'sub', 'cnt', 'cin', 'flx', 'grp', 'ae', 'csr',
        'mrp', 'mmd', 'mdp', 'dpm', 'dsp', 'dts', 'dsf'
    ];
BEGIN
    IF new_admin = '' THEN
        RAISE EXCEPTION 'Set new_admin to the identity configured in cse.admin (same value as Part 1).';
    END IF;

    SELECT ri INTO cb_ri FROM cb WHERE ty = 5 LIMIT 1;
    IF cb_ri IS NULL THEN
        RAISE EXCEPTION 'No <CSEBase> found. Start mobius4 once before running this migration.';
    END IF;

    acp_sid    := csebase_rn || '/' || acp_rn;
    privileges := jsonb_build_object('acr',
                    jsonb_build_array(jsonb_build_object('acor', jsonb_build_array(new_admin), 'acop', 63)));
    now_ts     := to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS');
    et         := to_char((now() + interval '12 months') AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISS');

    -- 1. The policy itself. Idempotent: a re-run refreshes the privileges rather than
    --    inserting a duplicate, which also makes this the way to rotate the admin identity.
    SELECT ri INTO acp_ri FROM acp WHERE sid = acp_sid;
    IF acp_ri IS NULL THEN
        -- ri is 10 characters from [0-9a-z]; md5 hex is a subset of that alphabet.
        acp_ri := substr(md5(random()::text || clock_timestamp()::text), 1, 10);

        INSERT INTO acp (ri, ty, sid, rn, pi, et, ct, lt, pv, pvs)
        VALUES (acp_ri, 1, acp_sid, acp_rn, cb_ri, et, now_ts, now_ts, privileges, privileges);

        INSERT INTO lookup (ri, ty, rn, sid, lvl, pi, cr, int_cr, et)
        VALUES (acp_ri, 1, acp_rn, acp_sid, 2, cb_ri, new_admin, new_admin, et);

        RAISE NOTICE 'admin acp created: % (ri %)', acp_sid, acp_ri;
    ELSE
        UPDATE acp SET pv = privileges, pvs = privileges, lt = now_ts WHERE ri = acp_ri;
        RAISE NOTICE 'admin acp already present, privileges refreshed: %', acp_sid;
    END IF;

    -- 2a. Older bootstraps listed the default policy twice on the <CSEBase>: create_cb seeded
    --     acpi with it and create_default_acp appended it again. Harmless but untidy, and the
    --     source of it is fixed in this release, so leave the data consistent too.
    UPDATE cb SET acpi = (SELECT array_agg(DISTINCT e ORDER BY e) FROM unnest(acpi) AS e)
     WHERE ri = cb_ri AND array_length(acpi, 1) > (SELECT count(DISTINCT e) FROM unnest(acpi) AS e);

    -- 2b. The <CSEBase> — the entry point for every request.
    UPDATE cb SET acpi = array_append(acpi, acp_sid)
     WHERE ri = cb_ri AND NOT (acp_sid = ANY(COALESCE(acpi, ARRAY[]::varchar[])));
    GET DIAGNOSTICS touched = ROW_COUNT; total := total + touched;

    -- 3. Every resource that already carries a policy. Empty acpi is skipped on purpose --
    --    see the note at the top of this part.
    FOREACH t IN ARRAY tables_with_acpi LOOP
        CONTINUE WHEN to_regclass('public.' || quote_ident(t)) IS NULL;
        EXECUTE format(
            'UPDATE %I SET acpi = array_append(acpi, $1)
              WHERE acpi IS NOT NULL AND array_length(acpi, 1) > 0
                AND NOT ($1 = ANY(acpi))', t) USING acp_sid;
        GET DIAGNOSTICS touched = ROW_COUNT; total := total + touched;
    END LOOP;

    RAISE NOTICE 'admin acp attached to % resources', total;
END $$;

COMMIT;
