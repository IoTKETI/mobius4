-- v4.20.0 — the missingData subscription condition and notificationEventType=8
-- (TS-0001:10.2.4.29, TS-0004:7.5.1.2.9).
--
-- Backward compatible: two nullable columns on an existing table, nothing altered or dropped. A
-- deployment that upgrades and never creates a net=8 subscription leaves both NULL forever.
--
-- These are internal bookkeeping, not oneM2M attributes -- the same status as ts.md_anchor_dgt and
-- ts.md_watermark_n from v4.16.0, and like those they are never returned in a representation.
--
--   md_window_end  the missing-data detection time at which this subscription's current window
--                  closes. NULL means no window is running, which is the state the clause calls
--                  "no timer has been started at all". Held as a value rather than as a live timer
--                  so that it survives a restart: an in-memory timer would silently reset every
--                  subscriber's window on every deployment.
--
--   md_points      the expected dataGenerationTime of each missing data point counted in the
--                  current window. The count the notification carries is this array's length --
--                  a separate counter column could disagree with the list, and the notification
--                  has to carry both, so there is no reason to store them twice. The <timeSeries>
--                  resource's own missingDataList is not usable for this: it is capped by
--                  missingDataMaxNr and shared by every subscription on the resource, while the
--                  clause asks for what was detected since *this* subscription's timer started.
--
-- Column widths follow config/default.json's "length" block (timestamp=20), matching db/init.js.

ALTER TABLE sub ADD COLUMN IF NOT EXISTS md_window_end VARCHAR(20);
ALTER TABLE sub ADD COLUMN IF NOT EXISTS md_points VARCHAR(20)[];
