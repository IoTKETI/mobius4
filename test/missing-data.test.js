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
    pei: 60, peid: 5, mdt: 30,
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
    pei: 60, peid: 5, mdt: 30,
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
    pei: 60, peid: 5, mdt: 30,
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
    pei: 60, peid: 5, mdt: 30,
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
    pei: 60, peid: 5, mdt: 30,
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
    pei: 60, peid: 5, mdt: 30,
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
    pei: 60, peid: 5, mdt: 30,
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
    pei: 60, peid: 5, mdt: 30,
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

// Boundary cases from TS-0001:10.2.4.29. The tests above land strictly inside (4s with peid: 5)
// or strictly outside (9s) the delta window, and use a `now` comfortably past or short of the
// detection time. Neither ever lands exactly on a boundary, which is where interval arithmetic
// like this tends to go wrong.

test("an instance exactly periodicIntervalDelta early counts as present (TS-0001:10.2.4.29)", () => {
  // 10:00:55 is exactly 5s before the expected 10:01:00, i.e. right at expected - periodicIntervalDelta.
  // The clause defines the range as "expected +/- periodicIntervalDelta", which reads as inclusive.
  const r = detect_missing({
    anchor: "20260815T100000",
    pei: 60, peid: 5, mdt: 30,
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
    pei: 60, peid: 5, mdt: 30,
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
    pei: 60, peid: 5, mdt: 30,
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
    pei: 60, peid: 5, mdt: 30,
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
    pei: 60, peid: 5, mdt: 30,
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
      pei: 60, peid: 5, mdt: 30,
      present_dgts: ["garbage"],
      now: "20260815T100300",
      from_n: null,
    }),
    (err) => err instanceof Error && err.message.includes("garbage"),
  );
});
