"use strict";
// Reporting missing Time Series Data to subscribers: TS-0001:10.2.4.29 and TS-0004:7.5.1.2.9.
//
// The clause's rules are labelled T1-T5 in its figure 10.2.4.29-1, and the unit tests below are
// named for them. They run against the pure core rather than a clock, because the whole point of
// storing a window end instead of holding a timer is that the outcome is a function of the data:
// a sweep that runs late must produce the same answer as one that runs on time.
//
// TS-0018 carries three test purposes for this feature. TP/oneM2M/CSE/TS/003 and /004 are
// implemented below. TP/oneM2M/CSE/TS/005 -- a final notification when the subscription is deleted
// -- is **not implemented**: the rule appears in no clause we could find (neither
// TS-0001:10.2.4.29 nor TS-0004:7.5.1.2.9 says anything about notifying at termination), and the
// TP's own Reference points at TS-0001 clause 10.2.39, a number that does not exist in the version
// of the document in the corpus. Tracked as SQ-008 rather than implemented on the strength of a
// test purpose alone.
//
// Everything not carrying a TP identifier is derived from the clause and says so.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, update, createRoot, uniqueRn } = require("./helpers/onem2m");
const { startSink, netOf } = require("./helpers/noti-sink");
const { from_epoch_seconds } = require("../cse/missing-data");
const {
  advance_window, duration_seconds, subscribes_to_missing_data, notification_body,
} = require("../cse/missing-data-subscription");

// ---------------------------------------------------------------- the pure core

// Detection times are plain seconds here; the real ones come from
// to_epoch_seconds(expected dgt) + missingDataDetectTimer.
const at = (s, dgt) => ({ dgt: dgt || `p${s}`, detection_s: s });
const EMPTY = { window_end_s: null, points: [] };

test("T1 — the first point starts the window and the counter", () => {
  const r = advance_window(EMPTY, [at(100)], { num: 3, dur_s: 60 });
  assert.equal(r.window_end_s, 160, "the window runs from the point's detection time");
  assert.deepEqual(r.points, ["p100"]);
  assert.deepEqual(r.notifications, [], "one point is below a threshold of three");
});

test("T2 — reaching the threshold notifies, carrying the points counted so far", () => {
  // TP/oneM2M/CSE/TS/003 asserts this over the wire; this is the same rule at the function that
  // decides it, where the boundary can be checked exactly.
  const r = advance_window(EMPTY, [at(100), at(110), at(120)], { num: 3, dur_s: 60 });
  assert.equal(r.notifications.length, 1, "one notification, at the third point");
  assert.deepEqual(r.notifications[0], { mdlt: ["p100", "p110", "p120"], mdc: 3 });
});

test("T3 — every further point in the same window notifies again", () => {
  const r = advance_window(EMPTY, [at(100), at(110), at(120), at(130), at(140)], { num: 3, dur_s: 60 });
  assert.deepEqual(r.notifications.map((n) => n.mdc), [3, 4, 5],
    "the counter keeps climbing; the window does not stop early");
  assert.deepEqual(r.notifications[2].mdlt, ["p100", "p110", "p120", "p130", "p140"]);
});

test("T4/T5 — a point past the window end resets the counter and starts a new window", () => {
  const r = advance_window(EMPTY, [at(100), at(110), at(200)], { num: 2, dur_s: 60 });
  assert.deepEqual(r.notifications.map((n) => n.mdc), [2], "only the pair inside the first window");
  assert.equal(r.window_end_s, 260, "the third point opened a window of its own");
  assert.deepEqual(r.points, ["p200"], "and the counter restarted at it");
});

test("the window is not restarted by expiry alone — only by the next detection", () => {
  // TS-0018에 해당 TP 없음. TS-0001:10.2.4.29: "This 'window duration' timer is restarted only upon
  // detection of next missing data point." An implementation that rolled the window forward on
  // expiry would put the next point in a window that started before it.
  const first = advance_window(EMPTY, [at(100)], { num: 2, dur_s: 10 });
  assert.equal(first.window_end_s, 110);
  const later = advance_window(first, [at(500)], { num: 2, dur_s: 10 });
  assert.equal(later.window_end_s, 510, "the new window starts at the point, not at 110 + n*10");
});

test("a point exactly at the window end belongs to the next window", () => {
  // TS-0018에 해당 TP 없음. Derived: the window "expires" at its end, so a detection at that
  // instant is after it. Asserted because it is the one boundary the two readings disagree on.
  const r = advance_window(EMPTY, [at(100), at(160)], { num: 2, dur_s: 60 });
  assert.deepEqual(r.notifications, [], "160 is not inside a window ending at 160");
  assert.deepEqual(r.points, ["p160"]);
});

test("no missing data point means no window at all", () => {
  // TS-0001:10.2.4.29: "If no missing data points have been detected at all during the lifetime of
  // a subscription, then no timer shall be started at all."
  const r = advance_window(EMPTY, [], { num: 1, dur_s: 60 });
  assert.equal(r.window_end_s, null);
  assert.deepEqual(r.notifications, []);
});

test("stored state resumes rather than restarting — a sweep is not a fresh start", () => {
  // TS-0018에 해당 TP 없음. This is what makes the state survive a restart: the second batch must
  // count on top of the first, not begin again.
  const first = advance_window(EMPTY, [at(100)], { num: 2, dur_s: 60 });
  const second = advance_window(first, [at(110)], { num: 2, dur_s: 60 });
  assert.deepEqual(second.notifications.map((n) => n.mdc), [2]);
  assert.deepEqual(second.notifications[0].mdlt, ["p100", "p110"]);
});

test("xs:duration is read in seconds, and a spelling with no components is not one", () => {
  assert.equal(duration_seconds("PT1M"), 60);
  assert.equal(duration_seconds("PT1H30M"), 5400);
  assert.equal(duration_seconds("P1D"), 86400);
  // A non-positive duration is accepted rather than refused -- the XSD does not forbid it. Its
  // consequence is well defined: every point opens and closes its own window.
  const r = advance_window(EMPTY, [at(100), at(101)], { num: 2, dur_s: 0 });
  assert.deepEqual(r.notifications, [], "no two points can share a zero-length window");
});

test("a subscription is a missing-data target only with both net=8 and md", () => {
  const md = { num: 2, dur: "PT1M" };
  assert.equal(subscribes_to_missing_data({ enc: { net: [8], md } }), true);
  assert.equal(subscribes_to_missing_data({ enc: { net: [8] } }), false, "net=8 with no condition");
  assert.equal(subscribes_to_missing_data({ enc: { net: [1], md } }), false,
    "md is ignored unless net is 8 — TS-0001:9.6.8 table 9.6.8-3");
  assert.equal(subscribes_to_missing_data({}), false);
});

test("the notification is a timeSeriesNotification, not a <timeSeries> representation", () => {
  // TS-0004:7.5.1.2.9 requires a timeSeriesNotification in notificationEvent/representation, and
  // TS-0004:6.3.5.62 makes it the representation for notificationContentType 5. Its root element's
  // short name is tsn (TS-0004:8.2.7) and its members are missingDataList and
  // missingDataCurrentNr (CDT-timeSeriesNotification.xsd:32).
  //
  // mdc here is the *subscription's* window counter, which is what TS-0001:10.2.4.29 asks for --
  // "detected since the start of the subscription's timer" — and not the <timeSeries> resource's
  // attribute of the same name. TP/oneM2M/CSE/TS/005 describes the payload differently; see
  // SQ-008.
  assert.deepEqual(notification_body({ mdlt: ["20260901T120000"], mdc: 1 }),
    { "m2m:tsn": { mdlt: ["20260901T120000"], mdc: 1 } });
});

// ---------------------------------------------------------------- validation, over HTTP

let srv, base, root, sink;
const SWEEP_SECONDS = 1;
const DETECTING = { pei: 2000, peid: 0, mdt: 1000, mdd: true };
const MD = { num: 2, dur: "PT1H" };

before(async () => {
  srv = await startServer({ cse: { missing_data_sweep_interval_seconds: SWEEP_SECONDS } });
  base = srv.baseUrl;
  sink = await startSink();
  root = await createRoot(base, "mdsub");
});
after(async () => {
  if (root) await root.remove();
  if (sink) await sink.stop();
  if (srv) await srv.stop();
});

const ago = (s) => from_epoch_seconds(Math.floor(Date.now() / 1000) - s);

async function makeSeries(extra = {}) {
  const rn = uniqueRn("ts");
  const res = await create(base, root.sid, 29, { "m2m:ts": { rn, ...DETECTING, ...extra } });
  assert.equal(res.rsc, "2001", `failed to create <ts>: ${res.raw.slice(0, 200)}`);
  return `${root.sid}/${rn}`;
}

async function subscribe(tsSid, enc, extra = {}) {
  const rn = uniqueRn("s");
  const res = await create(base, tsSid, 23, {
    "m2m:sub": { rn, nu: [sink.url], enc, ...extra },
  });
  return { res, sid: `${tsSid}/${rn}` };
}

test("a missing-data subscription on a <timeSeries> is accepted", async () => {
  const ts = await makeSeries();
  const { res } = await subscribe(ts, { net: [8], md: MD }, { nct: 5 });
  assert.equal(res.rsc, "2001", `should be created: ${res.raw.slice(0, 200)}`);
  assert.deepEqual(res.body["m2m:sub"].enc.md, MD, "the condition must survive the round trip");
});

test("notificationEventType 8 cannot be combined with another value", async () => {
  // TS-0018에 해당 TP 없음. TS-0001:9.6.8 table 9.6.8-3: value H "shall not be combined with any
  // other notificationEventType value".
  const ts = await makeSeries();
  const { res } = await subscribe(ts, { net: [8, 1], md: MD });
  assert.equal(res.rsc, "4000", `should be refused: ${res.raw.slice(0, 200)}`);
});

test("notificationContentType is pinned to 5 by net=8, and 5 is refused elsewhere", async () => {
  // TS-0018에 해당 TP 없음. TS-0001:9.6.8 table 9.6.8-4: for H the only valid value is "TimeSeries
  // notification", and every other net marks it n/a.
  const ts = await makeSeries();
  assert.equal((await subscribe(ts, { net: [8], md: MD }, { nct: 1 })).res.rsc, "4000");
  assert.equal((await subscribe(ts, { net: [8], md: MD }, { nct: 5 })).res.rsc, "2001");
  assert.equal((await subscribe(ts, { net: [8], md: MD })).res.rsc, "2001", "absent means the default");
  assert.equal((await subscribe(ts, { net: [1] }, { nct: 5 })).res.rsc, "4000",
    "nct=5 without net=8 has no representation to carry");
});

test("net=8 requires the subscribed-to resource to be a <timeSeries>", async () => {
  // TS-0018에 해당 TP 없음, and TS-0001:9.6.8 table 9.6.8-3 says only that the condition "applies
  // to" <timeSeries>, not that anything else must be refused. Refusing is a decision: the
  // alternative accepts the subscription and never notifies, which is the shape v4.19.0 removed
  // from net and om.
  const cnt = uniqueRn("c");
  await create(base, root.sid, 3, { "m2m:cnt": { rn: cnt } });
  const { res } = await subscribe(`${root.sid}/${cnt}`, { net: [8], md: MD });
  assert.equal(res.rsc, "4000", `should be refused on a <container>: ${res.raw.slice(0, 200)}`);
});

test("an incomplete or malformed missingData condition is refused", async () => {
  // TS-0018에 해당 TP 없음. CDT-commonTypes.xsd:1046 makes both members minOccurs=1, and duration
  // is xs:duration.
  const ts = await makeSeries();
  for (const md of [{ num: 2 }, { dur: "PT1H" }, { num: 0, dur: "PT1H" },
                    { num: 2, dur: "1 hour" }, { num: 2, dur: "P" }, { num: 2, dur: "PT" }]) {
    const { res } = await subscribe(ts, { net: [8], md });
    assert.equal(res.rsc, "4000", `md=${JSON.stringify(md)} should be refused, got ${res.rsc}`);
  }
});

test("UPDATE is held to the same combination rules, judged on the resulting resource", async () => {
  // TS-0018에 해당 TP 없음. A rule enforced only on CREATE is one a subscriber steps around in two
  // requests: create a valid net=8 subscription, then update nct alone.
  const ts = await makeSeries();
  const { res, sid } = await subscribe(ts, { net: [8], md: MD }, { nct: 5 });
  assert.equal(res.rsc, "2001", `setup failed: ${res.raw.slice(0, 200)}`);

  const bad = await update(base, sid, { "m2m:sub": { nct: 1 } });
  assert.equal(bad.rsc, "4000", "nct=1 against a stored net=8 must be refused");

  const combined = await update(base, sid, { "m2m:sub": { enc: { net: [8, 3], md: MD } } });
  assert.equal(combined.rsc, "4000", "combining net=8 with another value must be refused");

  const fine = await update(base, sid, { "m2m:sub": { enc: { net: [8], md: { num: 5, dur: "PT2H" } } } });
  assert.equal(fine.rsc, "2004", `changing the condition must be accepted: ${fine.raw.slice(0, 200)}`);
});

// ---------------------------------------------------------------- end to end, through the sweep

// Two gaps in the series: with pei=2 the expected times are anchor, anchor+2, anchor+4, anchor+6.
// Supplying the first and the last leaves the two in between missing.
async function seriesWithTwoGaps(tsSid) {
  for (const seconds of [10, 4]) {
    const res = await create(base, tsSid, 30, { "m2m:tsi": { con: "x", dgt: ago(seconds) } });
    assert.equal(res.rsc, "2001", `failed to create <tsi>: ${res.raw.slice(0, 200)}`);
  }
}

test("TP/oneM2M/CSE/TS/003 — notifies when the number of missing points reaches the threshold", async () => {
  const ts = await makeSeries();
  const { res, sid } = await subscribe(ts, { net: [8], md: { num: 2, dur: "PT1H" } }, { nct: 5 });
  assert.equal(res.rsc, "2001", `setup failed: ${res.raw.slice(0, 200)}`);

  await seriesWithTwoGaps(ts);

  const got = await sink.waitFor((i) => i.body?.["m2m:sgn"]?.sur === sid, { timeoutMs: 10000 });
  const sgn = got.body["m2m:sgn"];
  assert.equal(sgn.nev.net, 8);
  const tsn = sgn.nev.rep["m2m:tsn"];
  assert.ok(tsn, `the representation must be a timeSeriesNotification: ${JSON.stringify(sgn.nev.rep)}`);
  assert.equal(tsn.mdc, 2, "the count is what this subscription has seen since its window opened");
  assert.equal(tsn.mdlt.length, 2, `mdlt should carry both expected times: ${JSON.stringify(tsn.mdlt)}`);
  for (const dgt of tsn.mdlt) {
    assert.match(dgt, /^[0-9]{8}T[0-9]{6}$/, `expected a timestamp, got ${dgt}`);
  }
});

test("TP/oneM2M/CSE/TS/004 — does not notify while the count is below the threshold", async () => {
  // The control for the test above: a CSE that notified on every detection would pass TS/003 and
  // fail here, and one that never notified would pass here and fail TS/003.
  //
  // Stated as "no notification carries a count below the threshold" rather than "nothing arrives
  // within N seconds". A <timeSeries> with detection on and no further data accrues a new missing
  // point every periodicInterval for as long as it exists, so *any* threshold is reached
  // eventually and a quiet-window assertion would only be measuring how long the test waited. The
  // property the clause actually states is about the count, and it holds at every moment.
  const ts = await makeSeries();
  const THRESHOLD = 5;
  const { res, sid } = await subscribe(ts, { net: [8], md: { num: THRESHOLD, dur: "PT1H" } }, { nct: 5 });
  assert.equal(res.rsc, "2001", `setup failed: ${res.raw.slice(0, 200)}`);

  await seriesWithTwoGaps(ts);

  const mine = (i) => i.body?.["m2m:sgn"]?.sur === sid;
  const first = await sink.waitFor(mine, { timeoutMs: 15000 });
  assert.equal(first.body["m2m:sgn"].nev.rep["m2m:tsn"].mdc, THRESHOLD,
    "the first notification must be the one that reaches the threshold, not an earlier one");

  const below = sink.received.filter(mine)
    .map((i) => i.body["m2m:sgn"].nev.rep["m2m:tsn"].mdc)
    .filter((n) => n < THRESHOLD);
  assert.deepEqual(below, [], `no notification may carry a count below ${THRESHOLD}`);
});

test("a subscription without net=8 on the same <timeSeries> hears nothing (regression guard)", async () => {
  // TS-0018에 해당 TP 없음. Missing-data notifications must not leak into ordinary subscriptions
  // on the same resource.
  const ts = await makeSeries();
  const { res, sid } = await subscribe(ts, { net: [1] });
  assert.equal(res.rsc, "2001", `setup failed: ${res.raw.slice(0, 200)}`);

  await seriesWithTwoGaps(ts);

  await sink.expectNone(
    (i) => i.body?.["m2m:sgn"]?.sur === sid && netOf(i) === 8, { graceMs: 4000 });
});
