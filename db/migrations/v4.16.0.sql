-- v4.16.0 — <timeSeries> (ty 29) and <timeSeriesInstance> (ty 30).
--
-- Backward compatible: two new tables and their indexes, nothing altered. TS-0001:9.6.36
-- and 9.6.37. The md_anchor_dgt / md_watermark_n columns are internal bookkeeping for the
-- missing-data sweep (TS-0001:10.2.4.29) and are not oneM2M attributes.
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
  st INTEGER DEFAULT 0,
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
  acpi VARCHAR(255)[],
  lbl VARCHAR(255)[],
  st INTEGER,
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
