-- v4.23.0 — periodicInterval, periodicIntervalDelta and missingDataDetectTimer are milliseconds
--
-- Up to v4.22.5 mobius4 read these three <timeSeries> attributes as seconds. TS-0001:9.6.36 types
-- all three as xs:positiveInteger and states no unit anywhere in the prose or the XSD, so the
-- reading came from nothing but assumption. A conformance tester's arithmetic settles it:
-- TP/oneM2M/CSE/TS/001 was run against a <timeSeries> with pei 5000 and mdt 1000, and the resource
-- was read back nine seconds later expecting exactly one missing data point. That is a five-second
-- period detected one second late, and no other reading fits.
--
-- The code now divides by 1000. Existing rows still hold values written under the old reading, so
-- without this migration every stored period becomes a thousand times shorter: a <timeSeries>
-- created with pei 300 meaning five minutes would be read as 300 ms, and its missing-data sweep
-- would declare a gap roughly three times a second.
--
-- Multiplying the stored values keeps every existing resource behaving exactly as it did before
-- the upgrade. What changes for a client is the number it reads back: a resource created with
-- pei 300 now retrieves as pei 300000. The interval it describes is the same five minutes.
--
-- Safe to run more than once? NO. Running it twice multiplies by a million. Check first:
--   SELECT ri, pei, peid, mdt FROM ts WHERE pei IS NOT NULL LIMIT 5;
-- Values that look like plausible second counts (single or double digits, or a few hundred) have
-- not been migrated yet. Values in the thousands already have.

BEGIN;

UPDATE ts SET pei  = pei  * 1000 WHERE pei  IS NOT NULL;
UPDATE ts SET peid = peid * 1000 WHERE peid IS NOT NULL;
UPDATE ts SET mdt  = mdt  * 1000 WHERE mdt  IS NOT NULL;

COMMIT;
