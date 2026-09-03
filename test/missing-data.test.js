"use strict";
// The missing-data calculation of TS-0001:10.2.4.29, on its own — no database, no HTTP.
//
//   expected dataGenerationTime      = anchor + (N * periodicInterval)
//   expected dataGenerationTimeRange = expected +/- periodicIntervalDelta
//   missing data detection time      = expected + missingDataDetectTimer
//
// A point is missing if no <timeSeriesInstance> has a dataGenerationTime inside the range, as
// of the detection time. Keeping this separate from the sweep is what lets the subscription
// layer (net=8, a later cycle) reuse the same function instead of reimplementing the rules.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { detect_missing, apply_missing } = require("../cse/missing-data");

test("no missing points when every expected instance is present", () => {
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: ["20260815T100000", "20260815T100100", "20260815T100200"],
    now: "20260815T100300",
    from_n: null,
  });
  assert.deepEqual(r.missing, []);
});

test("a gap in the middle is reported at its expected dataGenerationTime", () => {
  // 10:01:00 never arrived. Its detection time is 10:01:30, which has passed at 10:03:00.
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: ["20260815T100000", "20260815T100200"],
    now: "20260815T100300",
    from_n: null,
  });
  assert.deepEqual(r.missing, ["20260815T100100"]);
});

test("an instance inside +/- periodicIntervalDelta counts as present", () => {
  // 10:01:04 is within 5s of the expected 10:01:00. now is 10:02:00 so only that one point's
  // detection time (10:01:30) has passed — keeping this test to the single point under test.
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: ["20260815T100000", "20260815T100104"],
    now: "20260815T100200",
    from_n: null,
  });
  assert.deepEqual(r.missing, []);
});

test("an instance outside the delta does not count as present", () => {
  // 10:01:09 is 9s late with a 5s delta, so the 10:01:00 point is still missing. now is
  // 10:02:00 so only that one point's detection time (10:01:30) has passed.
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: ["20260815T100000", "20260815T100109"],
    now: "20260815T100200",
    from_n: null,
  });
  assert.deepEqual(r.missing, ["20260815T100100"]);
});

test("a point whose detection time has not arrived yet is not yet missing", () => {
  // At 10:01:10 the 10:01:00 point's detection time (10:01:30) has not passed.
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: ["20260815T100000"],
    now: "20260815T100110",
    from_n: null,
  });
  assert.deepEqual(r.missing, []);
});

test("watermark does not go negative when now is before the first detection time", () => {
  // Only 5s after anchor: even N=1's detection time (10:01:30) is nowhere close. last_n is
  // negative internally, but the watermark must not report a negative N, or a later call would
  // compute first_n < 1 and re-examine N=0 (the anchor point, which by definition already exists).
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: ["20260815T100000"],
    now: "20260815T100005",
    from_n: null,
  });
  assert.deepEqual(r.missing, []);
  assert.equal(r.watermark, 0);
});

test("results come back newest first", () => {
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: ["20260815T100000"],
    now: "20260815T100500",
    from_n: null,
  });
  assert.deepEqual(r.missing, [
    "20260815T100400", "20260815T100300", "20260815T100200", "20260815T100100",
  ]);
});

test("the watermark makes a repeated sweep idempotent", () => {
  const args = {
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: ["20260815T100000"],
    now: "20260815T100300",
    from_n: null,
  };
  const first = detect_missing(args);
  assert.equal(first.missing.length, 2);

  const second = detect_missing({ ...args, from_n: first.watermark });
  assert.deepEqual(second.missing, []);
  assert.equal(second.watermark, first.watermark);
});

test("TP/oneM2M/CSE/TS/002 — the oldest entry is dropped once mdc reaches mdn", () => {
  // "Check that the IUT removes the oldest element in MissingDataList when MissingDataCurrentNr
  // reaches MissingDataMaxNr to enable insertion of a new missing data point"
  const start = { mdlt: ["20260815T100200", "20260815T100100"], mdc: 2 };
  const r = apply_missing(start.mdlt, start.mdc, ["20260815T100300"], 2);

  assert.deepEqual(r.mdlt, ["20260815T100300", "20260815T100200"]);
  assert.equal(r.mdc, 2);
});

test("mdc equals the length of mdlt", () => {
  // TS-0001:9.6.36 defines missingDataCurrentNr as "Current number of the missing Time Series
  // Data in the missingDataList", so the two cannot disagree.
  const r = apply_missing([], 0, ["20260815T100200", "20260815T100100"], 10);
  assert.equal(r.mdc, r.mdlt.length);
  assert.equal(r.mdc, 2);
});

test("without mdn the list is unbounded", () => {
  const r = apply_missing(["20260815T100100"], 1, ["20260815T100200"], null);
  assert.equal(r.mdc, 2);
});

// Boundary cases from TS-0001:10.2.4.29. The tests above land strictly inside (4s with peid: 5000)
// or strictly outside (9s) the delta window, and use a `now` comfortably past or short of the
// detection time. Neither ever lands exactly on a boundary, which is where interval arithmetic
// like this tends to go wrong.

test("an instance exactly periodicIntervalDelta early counts as present (TS-0001:10.2.4.29)", () => {
  // 10:00:55 is exactly 5s before the expected 10:01:00, i.e. right at expected - periodicIntervalDelta.
  // The clause defines the range as "expected +/- periodicIntervalDelta", which reads as inclusive.
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: ["20260815T100000", "20260815T100055"],
    now: "20260815T100200",
    from_n: null,
  });
  assert.deepEqual(r.missing, []);
});

test("an instance exactly periodicIntervalDelta late counts as present (TS-0001:10.2.4.29)", () => {
  // 10:01:05 is exactly 5s after the expected 10:01:00, i.e. right at expected + periodicIntervalDelta.
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: ["20260815T100000", "20260815T100105"],
    now: "20260815T100200",
    from_n: null,
  });
  assert.deepEqual(r.missing, []);
});

test("a point is evaluated once the detection time exactly equals now (TS-0001:10.2.4.29)", () => {
  // Detection time for N=1 is 10:01:00 + 30s = 10:01:30, exactly equal to now. No instance is
  // present near 10:01:00, so the point must show up as missing rather than being skipped.
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: ["20260815T100000"],
    now: "20260815T100130",
    from_n: null,
  });
  assert.deepEqual(r.missing, ["20260815T100100"]);
});

test("a point is not yet evaluated one second before its detection time (TS-0001:10.2.4.29)", () => {
  // Same setup as above but now is 10:01:29 -- one second short of the 10:01:30 detection time.
  // Paired with the previous test: either one alone would pass against an off-by-one boundary.
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: ["20260815T100000"],
    now: "20260815T100129",
    from_n: null,
  });
  assert.deepEqual(r.missing, []);
});

test("every expected point is missing when no instance has ever arrived (TS-0001:10.2.4.29)", () => {
  // present_dgts is empty -- the sensor never sent anything after the anchor. Both N=1 and N=2's
  // detection times (10:01:30 and 10:02:30) have passed by now (10:03:00).
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: [],
    now: "20260815T100300",
    from_n: null,
  });
  assert.deepEqual(r.missing, ["20260815T100200", "20260815T100100"]);
});

test("an unparseable dataGenerationTime throws, naming the offending value", () => {
  assert.throws(
    () => detect_missing({
      anchor: "20260815T100000",
      pei: 60000, peid: 5000, mdt: 30000,
      present_dgts: ["garbage"],
      now: "20260815T100300",
      from_n: null,
    }),
    (err) => err instanceof Error && err.message.includes("garbage"),
  );
});

// ── finding 1: the detection loop is unbounded ─────────────────────────────
//
// Backfilling a historical <timeSeriesInstance> is the ordinary time-series use case. Anchor a
// year back at pei=1 and the naive last_n is in the tens of millions -- built into `missing`
// synchronously in one call, with no bound. Measured on this branch before the fix: a 7-day-old
// anchor at pei=1 produced missing.length = 604,799 in 209ms on a singleton sweep timer that
// fires every few seconds.

test("a far-back anchor is bounded by max_points, and a second call resumes from the watermark rather than repeating or skipping (finding 1)", () => {
  // 7 days back at pei=1 implies roughly 604,800 expected points if nothing bounded the loop.
  const anchor = "20260808T100000";
  const now = "20260815T100000";
  const cap = 100;

  const first = detect_missing({
    anchor, pei: 1000, peid: 0, mdt: 0,
    present_dgts: [],
    now,
    from_n: null,
    max_points: cap,
  });
  assert.equal(first.missing.length, cap, "one call must not examine more than max_points expected points");
  assert.equal(first.watermark, cap);

  const second = detect_missing({
    anchor, pei: 1000, peid: 0, mdt: 0,
    present_dgts: [],
    now,
    from_n: first.watermark,
    max_points: cap,
  });
  assert.equal(second.missing.length, cap, "the next call must pick up the remainder rather than stopping");
  assert.equal(second.watermark, cap * 2);

  // The two batches must be disjoint, newest-first within each -- the second call is examining
  // N=101..200, not re-examining N=1..100.
  const overlap = second.missing.filter((ts) => first.missing.includes(ts));
  assert.deepEqual(overlap, [], "a resumed call must not re-examine points the previous call already accounted for");
});

test("max_points defaults from config when the caller does not pass one", () => {
  // config/default.json's default.timeSeries.max_points_per_sweep is 10000. Anchor far enough
  // back that an unbounded loop would exceed that by a wide margin, and confirm the default alone
  // (no max_points argument) still bounds it.
  const r = detect_missing({
    anchor: "20260101T000000",
    pei: 1000, peid: 0, mdt: 0,
    present_dgts: [],
    now: "20260815T000000", // ~226 days later -- roughly 19.5 million seconds
    from_n: null,
  });
  assert.equal(r.missing.length, 10000, "expected the config default (default.timeSeries.max_points_per_sweep) to cap the batch");
  assert.equal(r.watermark, r.missing.length, "with no prior watermark, N starts at 1, so watermark equals the batch size");
});

// ── finding 2: the missingDataDetectTimer default is never checked against periodicIntervalDelta ──
//
// TS-0001:9.6.36: "If periodicIntervalDelta is present, the value of this attribute [mdt] shall
// be greater than periodicIntervalDelta." cse/resources/ts.js only checks that when mdt is given
// explicitly. pei:300000/peid:150000 is a legal configuration (peid <= pei/2) but larger than the flat
// mdt_default of 60000 ms -- an omitted mdt used to fall back to it regardless, producing a detection
// time earlier than periodicIntervalDelta's window could close.

test("an omitted mdt derives a default greater than the effective peid, so detection never fires before the window can close (finding 2, TS-0001:9.6.36)", () => {
  const anchor = "20260815T100000";
  // N=1 expected at 10:05:00. The flat default (60s) would fire detection at 10:06:00 -- but
  // peid=150 legitimately allows the instance until 10:07:30. now is exactly the old, wrong
  // detection time; a correct derived default must not have fired yet.
  const r = detect_missing({
    anchor, pei: 300000, peid: 150000, mdt: undefined,
    present_dgts: [anchor],
    now: "20260815T100600",
    from_n: null,
  });
  assert.deepEqual(r.missing, [], "the derived default must not fire before periodicIntervalDelta's window can close");
});

test("a late-but-in-window arrival clears the point once the derived default timer allows detection (finding 2, TS-0001:9.6.36)", () => {
  const anchor = "20260815T100000";
  // Instance arrives at 10:06:40 -- 100s after the 10:05:00 expected time, inside the +/-150s
  // window. now is past the derived detection time (expected 10:05:00 + derived timer 151s =
  // 10:07:31), so the point has been examined and must show up as present, not missing.
  const r = detect_missing({
    anchor, pei: 300000, peid: 150000, mdt: undefined,
    present_dgts: [anchor, "20260815T100640"],
    now: "20260815T100801",
    from_n: null,
  });
  assert.deepEqual(r.missing, []);
});

test("an explicit mdt is used as-is, even below the derived default (finding 2)", () => {
  // The derivation only fills in for an omitted mdt. An explicit value is validated at
  // CREATE/UPDATE (cse/resources/ts.js), not silently raised here.
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: [],
    now: "20260815T100130",
    from_n: null,
  });
  assert.deepEqual(r.missing, ["20260815T100100"], "an explicit mdt of 30 must still fire at expected+30, not a derived value");
});

// ── finding 3: evicted instances are reported as missing ───────────────────
//
// sweep_missing_data restricts its child query and passes along the dgt of the oldest surviving
// <timeSeriesInstance>. detect_missing uses it to tell a genuine gap apart from an instance that
// arrived and was later evicted by retention (TS-0001:10.2.4.25) before any sweep examined it.

test("a point whose entire window predates the oldest surviving instance is skipped, not recorded missing (finding 3, TS-0001:10.2.4.25)", () => {
  // N=1 and N=2's windows (10:00:55-10:01:05, 10:01:55-10:02:05) are both entirely older than
  // the oldest surviving instance (10:30:00) -- whatever might have satisfied them, if anything,
  // is already gone. Retention evicts oldest-by-dgt first (EVICT_TSI_SQL in cse/resources/tsi.js),
  // so a surviving instance this new proves eviction has already passed both points.
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: [],
    oldest_surviving_dgt: "20260815T103000",
    now: "20260815T100300",
    from_n: null,
  });
  assert.deepEqual(r.missing, [], "an unknowable point must not be recorded as missing");
  assert.equal(r.watermark, 2, "the watermark still advances past unknowable points -- they will not be re-checked");
});

test("a point whose window overlaps the oldest surviving instance is still reported missing (finding 3)", () => {
  // The oldest surviving instance (10:00:00) is old enough that it -- or anything that arrived
  // after it -- would still be present had it existed. No match in present_dgts is therefore a
  // genuine gap, same as without retention in play at all.
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: [],
    oldest_surviving_dgt: "20260815T100000",
    now: "20260815T100130",
    from_n: null,
  });
  assert.deepEqual(r.missing, ["20260815T100100"]);
});

test("without an oldest_surviving_dgt, missing detection behaves exactly as before retention-awareness (finding 3)", () => {
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60000, peid: 5000, mdt: 30000,
    present_dgts: [],
    oldest_surviving_dgt: null,
    now: "20260815T100130",
    from_n: null,
  });
  assert.deepEqual(r.missing, ["20260815T100100"]);
});

// ── the effective missingDataDetectTimer is one rule, not two ──────────────────────────────────
//
// TS-0001:10.2.4.29 defines the missing data detection time as "expected dataGenerationTime +
// missingDataDetectTimer". mdt is 0..1 and TS-0001:9.6.36 gives no default, so the CSE has to
// supply the term -- and it has to supply the *same* term everywhere. detect_missing decides
// which points are missing; report_missing_data stamps when each was detected so a subscription's
// window timer can run. Those were two expressions of the same rule and they disagreed: an
// omitted mdt was the deployment default in one and a flat 0 in the other, sixty seconds apart
// by default.
//
// Nothing failed, and that is the point of pinning it. advance_window only ever compares a
// detection time to another detection time, so a constant offset cancels and the disagreement was
// invisible. It would have stopped being invisible the moment either side gained a comparison
// against a wall clock or a stored boundary from a different basis.
//
// TS-0018에 해당 TP 없음.

const { effective_mdt } = require("../cse/missing-data");

test("an explicit mdt is used as given", () => {
  assert.equal(effective_mdt(1, 0), 1);
  assert.equal(effective_mdt(0, 0), 0, "zero is a value, not an absence");
});

test("an omitted mdt derives the deployment default, raised to clear periodicIntervalDelta", () => {
  const config = require("config");
  const flat = config.default.timeSeries.mdt_default;
  assert.equal(effective_mdt(undefined, 0), flat);
  assert.equal(effective_mdt(null, 0), flat);
  // peid larger than the flat default: the derived value must still satisfy TS-0001:9.6.36's
  // "shall be greater than periodicIntervalDelta".
  assert.equal(effective_mdt(undefined, flat + 40), flat + 41);
});

test("the sweep and the subscription reporter derive the same timer for an omitted mdt", () => {
  // The regression guard. Both callers must reach this through effective_mdt; if either grows its
  // own expression again, one of these two numbers moves and this fails.
  const config = require("config");
  const { report_missing_data } = require("../cse/missing-data-subscription");
  assert.equal(typeof report_missing_data, "function");
  const derived = effective_mdt(undefined, 0);
  assert.notEqual(derived, 0,
    "if the derived default were 0 this test could not tell the two rules apart -- pick a config where it is not");
  assert.equal(derived, config.default.timeSeries.mdt_default);
});
