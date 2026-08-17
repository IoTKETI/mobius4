-- v4.16.0 — <timeSeries> (ty 29) and <timeSeriesInstance> (ty 30).
--
-- Backward compatible: two new tables and their indexes, nothing altered. TS-0001:9.6.36
-- and 9.6.37. The md_anchor_dgt / md_watermark_n columns are internal bookkeeping for the
-- missing-data sweep (TS-0001:10.2.4.29) and are not oneM2M attributes.
--
-- Neither attribute table has a stateTag entry, so "ts" and "tsi" have no "st" column. "tsi"
-- also has no "acpi" column: TS-0001:9.6.37 says <timeSeriesInstance> "inherits the same
-- access control policies of the parent <timeSeries> resource, and does not have its own
-- accessControlPolicyIDs attribute."
--
-- Column widths follow config/default.json's "length" block (ri_max=30, structured_res_id=255,
-- str_token=255, timestamp=20), the same values db/init.js uses via ${len.*} — not the shorter
-- literals an earlier draft of this migration had, which would have left a fresh deployment and
-- an upgraded one with different schemas.

CREATE TABLE IF NOT EXISTS ts (
  ri VARCHAR(30) PRIMARY KEY,
  ty INTEGER NOT NULL DEFAULT 29,
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
  cni INTEGER DEFAULT 0,
  cbs INTEGER DEFAULT 0,
  mni INTEGER,
  mbs INTEGER,
  mia INTEGER,
  pei INTEGER,
  peid INTEGER,
  mdd BOOLEAN NOT NULL DEFAULT FALSE,
  mdn INTEGER,
  mdlt VARCHAR(20)[] NOT NULL DEFAULT ARRAY[]::VARCHAR[],
  mdc INTEGER NOT NULL DEFAULT 0,
  mdt INTEGER,
  cnf VARCHAR(255),
  "or" VARCHAR(255),
  loc GEOMETRY(GEOMETRY, 4326),
  md_anchor_dgt VARCHAR(20),
  md_watermark_n INTEGER
);

CREATE TABLE IF NOT EXISTS tsi (
  ri VARCHAR(30) PRIMARY KEY,
  ty INTEGER NOT NULL DEFAULT 30,
  rn VARCHAR(255) NOT NULL,
  pi VARCHAR(30),
  sid VARCHAR(255) NOT NULL UNIQUE,
  et VARCHAR(20),
  ct VARCHAR(20),
  lt VARCHAR(20),
  lbl VARCHAR(255)[],
  cr VARCHAR(255),
  int_cr VARCHAR(255),
  loc GEOMETRY(GEOMETRY, 4326),
  dgt VARCHAR(20) NOT NULL,
  cs INTEGER,
  con JSONB,
  snr INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tsi_pi ON tsi (pi);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tsi_pi_dgt ON tsi (pi, dgt);

-- config/default.json's cse.supported_resource_types now lists 29 and 30, and db/init.js writes
-- that array into a fresh <CSEBase>'s "srt" column (INTEGER[]) at create_cb time. create_cb only
-- runs when no <cb> row exists yet, so an upgraded deployment's <CSEBase> keeps whatever srt it
-- already had -- it gains working <timeSeries>/<timeSeriesInstance> support from the tables
-- above while its own supportedResourceType attribute keeps advertising that neither exists.
--
-- Additive, not a replacement: an operator may have customized srt (removed a type this
-- deployment does not actually expose, added one of its own outside the range db/init.js seeds),
-- and this must not discard that. Idempotent: re-running after 29/30 are already present (from
-- this migration, or because the row was seeded fresh by db/init.js after this version shipped)
-- changes nothing -- the WHERE clause's NOT(... @> ...) is false once both are already there, and
-- the DISTINCT in the SELECT means even a concurrent partial application (only one of the two
-- already present) cannot introduce a duplicate.
UPDATE cb
   SET srt = (SELECT array_agg(DISTINCT e ORDER BY e)
                FROM unnest(COALESCE(srt, ARRAY[]::INTEGER[]) || ARRAY[29, 30]::INTEGER[]) AS e)
 WHERE ty = 5
   AND NOT (COALESCE(srt, ARRAY[]::INTEGER[]) @> ARRAY[29, 30]::INTEGER[]);
