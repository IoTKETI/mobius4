"use strict";
// The missing-data sweep end to end: a <timeSeries> with detection on, gaps in its
// <timeSeriesInstance> series, and the sweep that records them (TS-0001:10.2.4.29).
//
// The sweep is driven by the server's own interval, shortened to one second here, rather than by
// calling sweep_missing_data() from this process: startServer spawns the CSE as a child with the
// test database injected through NODE_CONFIG, so a call made here would run against a different
// database entirely. Driving it through the server also covers the wiring in mobius4.js, which a
// direct call would skip.
//
// The arithmetic itself is covered exhaustively and deterministically in test/missing-data.test.js;
// what is asserted here is that the wiring delivers it.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const config = require("config");
const { create, retrieve, update, createRoot, uniqueRn } = require("./helpers/onem2m");
const { startServer, TEST_DB } = require("./helpers/server");
const { from_epoch_seconds } = require("../cse/missing-data");
const { generate_ri, get_cur_time } = require("../cse/utils");

const SWEEP_SECONDS = 1;
let srv, base, root, db;

before(async () => {
  srv = await startServer({ cse: { missing_data_sweep_interval_seconds: SWEEP_SECONDS } });
  base = srv.baseUrl;
  root = await createRoot(base, "mds");

  // For inserting a <tsi> row that CREATE would now refuse (tsi_create_schema.dgt gained a
  // format regex — see test/timeseries.test.js "a malformed dataGenerationTime is refused at
  // CREATE"). The test process and the spawned server both point at the same TEST_DB by name
  // (test/helpers/server.js), and host/port/user/pw are not part of the overrides the server
  // gets, so this connects with the same values config/default.json (or config/local.json)
  // already gives this process — same pattern as test/access-control.test.js and
  // test/db-failure.test.js.
  const { user, pw, host, port } = config.get("db");
  db = new Client({ user, password: pw, host, port, database: TEST_DB });
  await db.connect();
});
after(async () => {
  if (srv) await srv.stop();
  if (db) await db.end();
});

// Inserts a <timeSeriesInstance> row directly, bypassing tsi_create_schema -- for the one test
// that needs a malformed dgt already sitting in the database, which the ordinary HTTP CREATE
// path refuses since res_schema.js gained format validation on dgt.
async function insertRawTsi(parentRi, dgt) {
  const ri = generate_ri();
  const now = get_cur_time();
  await db.query(
    `INSERT INTO tsi (ri, ty, rn, pi, sid, et, ct, lt, dgt, cs, con)
     VALUES ($1, 30, $2, $3, $4, $5, $5, $5, $6, $7, $8)`,
    [ri, `raw-${ri}`, parentRi, `raw-insert/${ri}`, now, dgt, 1, JSON.stringify("x")]
  );
  return ri;
}

// Timestamps are relative to the real clock because the sweep uses the real clock. Anchoring ten
// seconds back means several detection times have already passed by the first sweep.
function ago(seconds) {
  return from_epoch_seconds(Math.floor(Date.now() / 1000) - seconds);
}

// A maintenance connection to the "postgres" database, for CREATE DATABASE / DROP DATABASE --
// same pattern as test/db-failure.test.js. Needed by the finding-6 test below: it overrides
// default.timeSeries.mdn_default, and cse/singleton-role.js elects every plain (non-PM2) process
// as the singleton sweeper, so a second server sharing the main TEST_DB here would have its own
// sweep -- running with the *unoverridden* default -- race the main `srv`'s sweep over the same
// rows. An isolated database keeps the two sweeps from ever seeing the same <ts>.
async function withAdmin(fn) {
  const { user, pw, host, port } = config.get("db");
  const client = new Client({ user, password: pw, host, port, database: "postgres" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// atBase defaults to the shared server; tests that spin up their own pass theirs.
async function pollTs(sid, predicate, timeoutMs = 10000, atBase = null) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = (await retrieve(atBase || base, sid)).body["m2m:ts"];
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for <ts> ${sid}; last seen ${JSON.stringify(last)}`);
}

// pei 2000ms / peid 0 / mdt 1000ms makes a gap detectable about three seconds after its expected
// which the ten-second anchor offset guarantees has already elapsed.
const DETECTING = { pei: 2000, peid: 0, mdt: 1000, mdd: true };

async function makeSeries(extra = {}) {
  const res = await create(base, root.sid, 29, {
    "m2m:ts": { rn: uniqueRn("ts"), ...DETECTING, ...extra },
  });
  assert.equal(res.status, 201, `failed to create <ts>: ${res.raw?.slice(0, 200)}`);
  return res.body["m2m:ts"].ri;
}

test("TP/oneM2M/CSE/TS/001 — a detected gap lands in missingDataList and raises missingDataCurrentNr", async () => {
  // "Check that the IUT inserts the dataGenerationTime information of a missing data point and
  // increases the missingDataCurrentNr attribute when a missing data point is detected"
  const sid = await makeSeries();
  const t0 = Math.floor(Date.now() / 1000) - 10;

  // anchor at t0, then skip t0+2 and send t0+4
  await create(base, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: from_epoch_seconds(t0), con: "1" } });
  await create(base, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: from_epoch_seconds(t0 + 4), con: "3" } });

  const body = await pollTs(sid, (b) => b.mdc > 0);
  assert.ok(
    body.mdlt.includes(from_epoch_seconds(t0 + 2)),
    `expected the skipped point ${from_epoch_seconds(t0 + 2)} in ${JSON.stringify(body.mdlt)}`
  );
  assert.equal(body.mdc, body.mdlt.length);
});

test("TP/oneM2M/CSE/TS/002 — missingDataList is capped at missingDataMaxNr, dropping the oldest", async () => {
  // "Check that the IUT removes the oldest element in MissingDataList when MissingDataCurrentNr
  // reaches MissingDataMaxNr to enable insertion of a new missing data point"
  const sid = await makeSeries({ mdn: 2 });
  await create(base, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: ago(10), con: "1" } });

  const atCap = await pollTs(sid, (b) => b.mdc === 2);
  const firstEntry = atCap.mdlt[0];

  // Gaps keep accruing every pei seconds, so the newest entry changes while the length holds.
  const rotated = await pollTs(sid, (b) => b.mdlt[0] !== firstEntry);
  assert.equal(rotated.mdc, 2, "missingDataCurrentNr must not grow past missingDataMaxNr");
  assert.equal(rotated.mdlt.length, 2);
});

test("TS-0001:10.2.4.23 — pausing keeps the recorded state, restarting clears it", async () => {
  const sid = await makeSeries();
  await create(base, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: ago(10), con: "1" } });
  const recorded = await pollTs(sid, (b) => b.mdc > 0);

  // "If missingDataDetect is modified to false the Hosting CSE will pause the missing data
  // detection process" — and keeps missingDataList and missingDataCurrentNr.
  const paused = await update(base, sid, { "m2m:ts": { mdd: false } });
  assert.equal(paused.body["m2m:ts"].mdd, false);
  assert.equal(paused.body["m2m:ts"].mdc, recorded.mdc);

  // Two sweeps' worth of quiet: a paused resource must not accrue anything.
  await new Promise((r) => setTimeout(r, SWEEP_SECONDS * 2500));
  assert.equal((await retrieve(base, sid)).body["m2m:ts"].mdc, recorded.mdc);

  // "When the missingDataDetect is updated from false to true the Hosting CSE will clear the
  // missingDataList and missingDataCurrentNr." Asserted on the update response rather than a
  // later retrieve, because detection resumes immediately and will record again.
  const restarted = await update(base, sid, { "m2m:ts": { mdd: true } });
  assert.equal(restarted.body["m2m:ts"].mdc, 0);
  assert.equal(restarted.body["m2m:ts"].mdlt, undefined, "0..1 (L): an empty list is not sent");
});

test("TS-0001:10.2.4.23 Exceptions — editing a detection parameter while detection is running is refused", async () => {
  // The Exceptions row: "An error will be generated if any of the following attributes are
  // modified while the value of missingDataDetect is true: missingDataDetectTimer,
  // missingDataMaxNr, periodicIntervalDelta, periodicInterval." makeSeries() creates with
  // mdd: true (DETECTING), so this <ts> is already running detection when the edit arrives.
  const sid = await makeSeries();
  await create(base, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: ago(10), con: "1" } });
  const before = await pollTs(sid, (b) => b.mdc > 0);

  const edited = await update(base, sid, { "m2m:ts": { pei: 300000 } });
  assert.equal(edited.status, 400);
  assert.equal(edited.rsc, "4000"); // BAD_REQUEST

  const after = (await retrieve(base, sid)).body["m2m:ts"];
  assert.equal(after.mdd, true, "a refused update must not change mdd");
  assert.equal(after.pei, 2000, "a refused update must not change pei");
  assert.equal(after.mdc, before.mdc, "a refused update must not clear the recorded state");
});

test("TS-0001:10.2.4.23 Exceptions — a no-op resend of an unchanged detection parameter is accepted (finding 4)", async () => {
  // The Exceptions row refuses attributes "modified" while missingDataDetect is true, not
  // attributes merely present in the request. Read-modify-write is an ordinary client pattern --
  // RETRIEVE, change something unrelated like lbl, PUT the whole resource back -- which echoes
  // pei/peid/mdt unchanged. That echo must not be refused as a modification.
  const sid = await makeSeries(); // pei:2000, peid:0, mdt:1000, mdd:true
  const before = (await retrieve(base, sid)).body["m2m:ts"];

  const resent = await update(base, sid, {
    "m2m:ts": { lbl: ["updated"], pei: before.pei, peid: before.peid, mdt: before.mdt },
  });
  assert.equal(resent.status, 200, `an unchanged resend must not be refused: ${resent.raw?.slice(0, 200)}`);
  assert.deepEqual(resent.body["m2m:ts"].lbl, ["updated"], "the unrelated attribute must still apply");
  assert.equal(resent.body["m2m:ts"].pei, before.pei);
  assert.equal(resent.body["m2m:ts"].mdd, true, "an accepted no-op resend must not be treated as pausing/restarting detection");

  // A genuine change in the same request is still refused -- this fix narrows the check to
  // per-attribute equality, it does not disable the Exceptions row.
  const genuinelyChanged = await update(base, sid, { "m2m:ts": { pei: before.pei + 100 } });
  assert.equal(genuinelyChanged.status, 400);
  assert.equal(genuinelyChanged.rsc, "4000");
});

test("TS-0001:10.2.4.23 — editing a detection parameter while paused still clears the recorded state", async () => {
  // The neighbouring "Processing at Receiver" addition, distinct from the Exceptions row above:
  // "If any parameters related to the missing data detection process ... are updated while the
  // data detection process is paused the Hosting CSE will clear the missingDataList and
  // missingDataCurrentNr."
  const sid = await makeSeries();
  await create(base, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: ago(10), con: "1" } });
  await pollTs(sid, (b) => b.mdc > 0);

  const paused = await update(base, sid, { "m2m:ts": { mdd: false } });
  assert.equal(paused.body["m2m:ts"].mdd, false);

  const edited = await update(base, sid, { "m2m:ts": { pei: 300000 } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body["m2m:ts"].mdd, false, "the edit must not itself resume detection");
  assert.equal(edited.body["m2m:ts"].mdc, 0);
  assert.equal(edited.body["m2m:ts"].pei, 300000);
});

test("TS-0001:10.2.4.21 — detection runs only when pei is set and mdd is true", async () => {
  // "If the periodicInterval attribute is set and the missingDataDetect attribute is TRUE, the
  // Hosting CSE shall begin the procedure defined in clause 10.2.4.29."
  const noPei = (await create(base, root.sid, 29, {
    "m2m:ts": { rn: uniqueRn("ts"), mdd: true },
  })).body["m2m:ts"].ri;
  const noMdd = (await create(base, root.sid, 29, {
    "m2m:ts": { rn: uniqueRn("ts"), pei: 2000, peid: 0, mdt: 1000 },
  })).body["m2m:ts"].ri;
  // A correctly-configured control, given the same data as the two above. Without it, this test
  // proves nothing about the filter: it would pass identically if the sweep did not exist at
  // all, which is exactly what happened when the implementer ran it in the RED state before
  // sweep_missing_data() was written. The control makes "the two misconfigured ones stayed at
  // zero" mean something, by also proving a correctly-configured sibling did not.
  const control = await makeSeries();

  for (const sid of [noPei, noMdd, control]) {
    await create(base, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: ago(10), con: "1" } });
  }

  // Prove the sweep is actually live — bounded poll, not part of the timing margin below.
  const controlBody = await pollTs(control, (b) => b.mdc > 0);
  assert.ok(controlBody.mdlt.length > 0, "the correctly-configured control must accrue a missing point");

  await new Promise((r) => setTimeout(r, SWEEP_SECONDS * 3000));

  for (const sid of [noPei, noMdd]) {
    const body = (await retrieve(base, sid)).body["m2m:ts"];
    assert.equal(body.mdc, 0);
    assert.equal(body.mdlt, undefined);
  }
});

test("TS-0001:10.2.4.29 — a malformed dgt on one <ts> must not starve the sweep for the rest", async () => {
  // The plan's original try/catch wrapped only detect_missing. Anchor establishment (the
  // to_epoch_seconds calls inside sweep_missing_data's reduce) and row.save() sat outside it, so
  // a throw from either escaped sweep_missing_data() entirely: every candidate after the bad one
  // in that tick's query result was skipped, and — because the throw fires before md_anchor_dgt
  // is persisted — it recurred on every subsequent tick, permanently starving whatever sorted
  // after the bad resource in the query result.
  //
  // dgt gained format validation on the create path (tsi_create_schema now applies the same
  // regex create_common_attr.et uses, so the ordinary HTTP CREATE refuses "not-a-timestamp"
  // with 4000 — see test/timeseries.test.js "a malformed dataGenerationTime is refused at
  // CREATE"). Rows can still predate that validation, or arrive through any path this CSE does
  // not control, so the sweep still has to tolerate one — insertRawTsi writes the row directly,
  // bypassing the schema the way an old row would have gotten in before this fix existed.
  //
  // The bad <ts> needs at least two children, not one: Array.prototype.reduce with no initial
  // value on a single-element array returns that element without ever calling the reducer, so
  // to_epoch_seconds is never invoked there and the throw would happen inside detect_missing
  // instead — the one call the original try/catch already covered, proving nothing about this
  // fix. With two children the reducer runs and throws while comparing them, before the try.
  const bad = await makeSeries();
  await create(base, bad, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: ago(20), con: "1" } });
  await insertRawTsi(bad, "not-a-timestamp");

  const good = await makeSeries();
  await create(base, good, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: ago(10), con: "1" } });

  const goodBody = await pollTs(good, (b) => b.mdc > 0);
  assert.ok(goodBody.mdlt.length > 0, "the resource after the malformed one must still accrue normally");

  // The malformed resource itself never gets an anchor (the row that would set it is never
  // persisted, since the throw happens before row.save()), so it is skipped every tick rather
  // than silently succeeding.
  const badBody = (await retrieve(base, bad)).body["m2m:ts"];
  assert.equal(badBody.mdc, 0, "the malformed resource itself is skipped, not silently processed");
});

test("TS-0001:9.6.36 — an omitted mdt with a peid larger than the flat deployment default is accepted, and does not fabricate a missing point (finding 2)", async () => {
  // pei:140000/peid:70000 is a legal configuration (peid <= pei/2, at the boundary) but peid is larger
  // than the deployment's flat default.timeSeries.mdt_default (60000 ms). Two real-time submissions,
  // deliberately spaced apart, are what make this differ from just checking detect_missing's
  // arithmetic directly: under the old flat default, N=1's detection time is only 6s after this
  // test starts -- before the late arrival below is even sent -- so the sweep would already have
  // recorded it missing and, since the watermark only looks forward, never revisit it once the
  // arrival lands. The derived default (periodicIntervalDelta+1 = 71) does not fire until 17s in,
  // by which point the arrival has been sitting there for 6s already.
  //
  // CREATE must accept the configuration regardless of which default applies: the client never
  // supplied mdt, so there is nothing of theirs to validate against peid (see the reasoning on
  // detect_missing in cse/missing-data.js).
  const res = await create(base, root.sid, 29, {
    "m2m:ts": { rn: uniqueRn("ts"), pei: 140000, peid: 70000, mdd: true },
  });
  assert.equal(res.status, 201, `omitted mdt with peid=70 must be accepted: ${res.raw?.slice(0, 200)}`);
  const sid = res.body["m2m:ts"].ri;

  const setup = Math.floor(Date.now() / 1000);
  const t0 = setup - 194; // expected(N=1) = t0 + 140 = setup - 54
  await create(base, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: from_epoch_seconds(t0), con: "1" } });

  // Land at setup+11: after the old flat default's detection time for N=1 (setup+6) but well
  // before the derived default's (setup+17).
  await new Promise((r) => setTimeout(r, 11000));
  await create(base, sid, 30, {
    // expected(N=1) + 50 -- inside the +/-70 window.
    "m2m:tsi": { rn: uniqueRn("i"), dgt: from_epoch_seconds(t0 + 190), con: "2" },
  });

  // Past setup+17 (the derived detection time) with margin for sweep-tick granularity.
  await new Promise((r) => setTimeout(r, 11000));
  const body = (await retrieve(base, sid)).body["m2m:ts"];
  assert.equal(body.mdc, 0, "the in-window late arrival must not be recorded missing");
});

test("TS-0001:10.2.4.25 — instances evicted before the sweep reaches them are not reported missing, but a genuine gap in what survives still is (finding 3)", async () => {
  // Simulates the deployment shape cse/singleton-role.js exists for: the sweeper falls behind
  // (down, failing over) for longer than mni*pei while retention keeps evicting and new data
  // keeps arriving. By the time the sweeper looks at the early, unexamined points, whatever might
  // have satisfied them is already gone -- there is no way to tell a genuine gap from an evicted
  // arrival apart from a genuine one. Fixture rows are written directly with the pg client
  // (test/container-retention.test.js's pattern) rather than posting the ~90 instances a faithful
  // eviction sequence would need.
  const sid = await makeSeries(); // pei:2000, peid:0, mdt:1000, mdd:true

  const t0 = Math.floor(Date.now() / 1000) - 200; // detection "started" 200s ago
  const PEI = 2;

  // Fixture rows first, anchor last (finding 3): a sweep tick landing between the two writes
  // would otherwise see an anchor already installed but zero children under it, conclude nothing
  // needs skipping, and record ~99 genuine-looking gaps -- advancing the watermark past them
  // before the fixture rows ever existed from the sweep's point of view. No later tick can undo
  // an advanced watermark, so that race made the final assertion below fail intermittently. With
  // the rows in place first, the earliest a sweep can observe this <ts> at all is after both
  // writes have landed.
  //
  // Only N=90..150 survive (dgt = t0 + N*PEI), as if retention had already evicted N=1..89 by
  // the time the sweeper looks -- gapless except N=95, a genuine gap left in on purpose so this
  // test cannot pass by the fix simply suppressing everything. The range runs 100s past "now" so
  // ordinary test timing jitter cannot push the sweep into examining a point this fixture does
  // not cover.
  for (let n = 90; n <= 150; n++) {
    if (n === 95) continue;
    await insertRawTsi(sid, from_epoch_seconds(t0 + n * PEI));
  }

  // Install detection state directly, as if this <ts> had been detecting since t0 but the
  // sweeper never got past N=0 before retention moved on -- bypasses ts.js's
  // clear_detection_state, which any path through the app would apply on an mdd transition.
  await db.query(
    `UPDATE ts SET md_anchor_dgt = $1, md_watermark_n = 0 WHERE ri = $2`,
    [from_epoch_seconds(t0), sid]
  );

  // One tick is enough: with the anchor and watermark already installed, and the whole
  // examinable range (roughly N=1..100, depending on real elapsed time) well under
  // default.timeSeries.max_points_per_sweep, the first sweep that reaches this <ts> processes it
  // in full.
  await new Promise((r) => setTimeout(r, SWEEP_SECONDS * 2500));

  const body = (await retrieve(base, sid)).body["m2m:ts"];
  assert.equal(body.mdc, 1, `expected exactly the one genuine gap (N=95), got ${JSON.stringify(body.mdlt)}`);
  assert.deepEqual(body.mdlt, [from_epoch_seconds(t0 + 95 * PEI)]);
});

test("TS-0001:9.6.36 — missingDataList does not grow without bound when missingDataMaxNr is absent (finding 6)", async () => {
  // apply_missing itself stays faithful to the spec -- an explicit null still means unbounded at
  // the function level (see test/missing-data.test.js "without mdn the list is unbounded"). The
  // cap belongs one layer up, at the sweep, as a deployment safeguard against the VARCHAR(20)[]
  // mdlt column's eventual field-size limit. A dedicated server, on a database of its own (see
  // withAdmin above), overrides default.timeSeries.mdn_default down to a small number, so the
  // bound is observable without waiting out the real default of 10000.
  const MDN_CAP_DB = "mobius4_test_mdn_cap";
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${MDN_CAP_DB}`);
    await c.query(`CREATE DATABASE ${MDN_CAP_DB}`);
  });
  const capSrv = await startServer({
    dbName: MDN_CAP_DB,
    cse: { missing_data_sweep_interval_seconds: SWEEP_SECONDS },
    defaults: { timeSeries: { mdn_default: 5 } },
  });
  try {
    const capBase = capSrv.baseUrl;
    const capRoot = await createRoot(capBase, "mdncap");

    // No mdn in the request -- TS-0001:9.6.36 makes missingDataList unbounded for this resource;
    // only the deployment-level default caps what the sweep actually accrues.
    const created = await create(capBase, capRoot.sid, 29, {
      "m2m:ts": { rn: uniqueRn("ts"), pei: 1000, peid: 0, mdt: 1000, mdd: true },
    });
    assert.equal(created.status, 201, `failed to create <ts>: ${created.raw?.slice(0, 200)}`);
    const sid = created.body["m2m:ts"].ri;

    // One instance, anchored 300s back, establishes the anchor. With nothing else ever arriving,
    // a single sweep tick's backlog (bounded by max_points_per_sweep, still 10000 here) is
    // roughly 300 -- comfortably past the overridden mdn_default of 5.
    const t0 = Math.floor(Date.now() / 1000) - 300;
    await create(capBase, sid, 30, {
      "m2m:tsi": { rn: uniqueRn("i"), dgt: from_epoch_seconds(t0), con: "1" },
    });

    const deadline = Date.now() + 10000;
    let body;
    do {
      body = (await retrieve(capBase, sid)).body["m2m:ts"];
      if (body.mdc > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    } while (Date.now() < deadline);

    assert.equal(body.mdc, 5, `expected the deployment default to cap accrual at 5, got mdc=${body.mdc} mdlt=${JSON.stringify(body.mdlt)}`);
    assert.equal(body.mdlt.length, 5);
    assert.equal(body.mdn, undefined, "the fallback must not be written back as the resource's own missingDataMaxNr");

    // pei:1000/mdt:1000 keeps producing a newly-due expected point roughly every second, so a second
    // tick has more to fold in -- the cap must hold across repeated ticks, not just stop the
    // first time it is reached.
    await new Promise((r) => setTimeout(r, SWEEP_SECONDS * 2000));
    const later = (await retrieve(capBase, sid)).body["m2m:ts"];
    assert.equal(later.mdc, 5, "the cap must hold across repeated sweep ticks, not just the first");
    assert.equal(later.mdlt.length, 5);
  } finally {
    await capSrv.stop();
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${MDN_CAP_DB}`));
  }
});

test("a late arrival leaves its expected slot missing, but not before the detect timer elapses", async () => {
  // The reported shape, scaled down in time: data is expected every periodicInterval and the next
  // instance turns up half a period late. TS-0001:10.2.4.29 makes the skipped slot a missing data
  // point -- the expected dataGenerationTime is anchor + N*pei and periodicIntervalDelta is the
  // only tolerance, so an instance stamped between two slots satisfies neither.
  //
  // What had no coverage is the second half: WHEN it shows up. Every existing test here sets mdt
  // explicitly, so nothing pinned what an omitted mdt does, and the answer is not "immediately" --
  // detection is at expected + missingDataDetectTimer, and with no mdt on the resource that term
  // comes from default.timeSeries.mdt_default, 60000 ms as shipped. A <ts> with pei measured in
  // seconds therefore shows an empty missingDataList for a full minute, which reads exactly like
  // detection being broken. Overridden to 3 here so the boundary is observable in a test; the
  // point being pinned is that there IS a boundary and where it comes from.
  //
  // TS-0018에 해당 TP 없음.
  const LATE_DB = "mobius4_test_late_arrival";
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${LATE_DB}`);
    await c.query(`CREATE DATABASE ${LATE_DB}`);
  });
  const lateSrv = await startServer({
    dbName: LATE_DB,
    cse: { missing_data_sweep_interval_seconds: SWEEP_SECONDS },
    defaults: { timeSeries: { mdt_default: 3000 } },
  });
  try {
    const lateBase = lateSrv.baseUrl;
    const lateRoot = await createRoot(lateBase, "late");

    // No mdt on the resource -- that is the case under test.
    const created = await create(lateBase, lateRoot.sid, 29, {
      "m2m:ts": { rn: uniqueRn("ts"), pei: 2000, peid: 0, mdd: true },
    });
    assert.equal(created.status, 201, `failed to create <ts>: ${created.raw?.slice(0, 200)}`);
    const sid = created.body["m2m:ts"].ri;

    // Anchor now, so the timing below is relative to a known instant rather than to whenever the
    // fixture happened to run.
    const t0 = Math.floor(Date.now() / 1000);
    const anchoredAt = Date.now();
    await create(lateBase, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: from_epoch_seconds(t0), con: "1" } });
    // Half a period late: the t0+2 slot is skipped and this instance fills none.
    await create(lateBase, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: from_epoch_seconds(t0 + 3), con: "2" } });

    // Expected t0+2, detected at t0+2+3 = t0+5. At t0+2 several sweeps have run and it must still
    // be absent -- the slot is already overdue, only the detect timer is holding it back.
    await new Promise((r) => setTimeout(r, Math.max(0, anchoredAt + 2000 - Date.now())));
    const early = (await retrieve(lateBase, sid)).body["m2m:ts"];
    assert.equal(early.mdc, 0, `nothing may be detected before expected + mdt: ${JSON.stringify(early.mdlt)}`);
    assert.equal(early.mdlt, undefined, "0..1 (L): an empty list is not sent");

    const body = await pollTs(sid, (b) => b.mdc > 0, 15000, lateBase);
    assert.ok(
      body.mdlt.includes(from_epoch_seconds(t0 + 2)),
      `the skipped slot ${from_epoch_seconds(t0 + 2)} must be listed, got ${JSON.stringify(body.mdlt)}`
    );
    assert.equal(
      body.mdlt.includes(from_epoch_seconds(t0 + 3)), false,
      "the late instance's own dataGenerationTime is data that arrived, not a missing point"
    );
  } finally {
    await lateSrv.stop();
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${LATE_DB}`));
  }
});

test("a dataGenerationTime ahead of the CSE clock is warned about, and detects nothing", async () => {
  // Both halves matter and they say different things.
  //
  // Detects nothing: TS-0001:10.2.4.29 measures expected points from the first instance's dgt, so
  // an anchor in the future puts every expected point in the future. The CSE is behaving correctly
  // -- there is nothing overdue -- but from outside it is indistinguishable from broken detection,
  // and that is what a conformance tester's run looked like: pei 5000, mdt 1000, one instance, a
  // read nine seconds later, and mdc 0. Its dgt ran two hours ahead of the ct this CSE assigned in
  // the same second. m2m:timestamp carries no timezone, so nothing in the exchange says so.
  //
  // Warned about: which is the only thing that makes it findable. That half needs its own server,
  // because the shared one runs at logLevel "error" and would drop the record -- and a warning
  // nobody asserts is a warning that can stop being emitted without anyone noticing.
  //
  // TS-0018에 해당 TP 없음.
  const AHEAD_DB = "mobius4_test_dgt_ahead";
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${AHEAD_DB}`);
    await c.query(`CREATE DATABASE ${AHEAD_DB}`);
  });
  const aheadSrv = await startServer({
    dbName: AHEAD_DB,
    logLevel: "warn",
    cse: { missing_data_sweep_interval_seconds: SWEEP_SECONDS },
  });
  try {
    const aheadBase = aheadSrv.baseUrl;
    const aheadRoot = await createRoot(aheadBase, "ahead");
    const created = await create(aheadBase, aheadRoot.sid, 29, {
      "m2m:ts": { rn: uniqueRn("ts"), ...DETECTING },
    });
    assert.equal(created.status, 201, `failed to create <ts>: ${created.raw?.slice(0, 200)}`);
    const sid = created.body["m2m:ts"].ri;

    const AHEAD_S = 7200;   // the offset actually observed against the tester
    const future = from_epoch_seconds(Math.floor(Date.now() / 1000) + AHEAD_S);
    const made = await create(aheadBase, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: future, con: "1" } });
    assert.equal(made.status, 201, "a future dgt is legal and must still be accepted");

    await new Promise((r) => setTimeout(r, SWEEP_SECONDS * 3000));
    const body = (await retrieve(aheadBase, sid)).body["m2m:ts"];
    assert.equal(body.mdc, 0, `nothing is overdue when the anchor is in the future: ${JSON.stringify(body.mdlt)}`);
    assert.equal(body.mdlt, undefined);

    const diag = aheadSrv.diagnostics();
    assert.ok(diag.includes("dataGenerationTime is ahead of this CSE clock"),
      `the CSE must say so; without it this state is invisible to whoever is debugging it. Log tail: ${diag.slice(-600)}`);
    assert.ok(diag.includes(future), "the warning must name the dataGenerationTime it is about");
  } finally {
    await aheadSrv.stop();
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${AHEAD_DB}`));
  }
});

test("detection lands within the detect timer, not within the configured sweep interval", async () => {
  // The sweep ran on a fixed cadence, so a gap that TS-0001:10.2.4.29 makes detectable at
  // "expected dataGenerationTime + missingDataDetectTimer" was reported up to a whole interval
  // later. On the shipped 30 seconds and a conformance tester's <timeSeries> (pei 5000, mdt 1000,
  // one instance), the resource still reported missingDataCurrentNr 0 nine and twenty seconds
  // after a gap that was real at six.
  //
  // The interval here is 300 seconds, far longer than anything this test waits for, and that is
  // the whole design of it. The sweep now paces itself, but a pass that finds nothing detectable
  // has no due time to pace from and falls back to the ceiling -- so a CSE that has been idle is
  // asleep for the full interval, and everything created during that sleep is invisible until it
  // ends. An earlier version of this test set the interval to the shipped 30 seconds and created
  // the <timeSeries> immediately, which landed inside the first pass at 250 ms and passed while
  // that hole was still open. A warm CSE showed mdc 0 at nine seconds; this configuration makes
  // the same failure certain rather than a race.
  //
  // So what is really pinned here is the wake: nothing but cse/missing-data-scheduler.js's wake()
  // can produce a detection inside 300 seconds.
  //
  // TS-0018에 해당 TP 없음 -- TP/oneM2M/CSE/TS/001 asserts what missingDataList contains once a
  // point is detected, not how soon after its detection time that happens.
  const PACED_DB = "mobius4_test_paced_sweep";
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${PACED_DB}`);
    await c.query(`CREATE DATABASE ${PACED_DB}`);
  });
  const pacedSrv = await startServer({
    dbName: PACED_DB,
    cse: { missing_data_sweep_interval_seconds: 300 },
  });
  try {
    const pacedBase = pacedSrv.baseUrl;
    const pacedRoot = await createRoot(pacedBase, "paced");

    // Past the scheduler's 250 ms first pass, so the sweep is provably asleep on the ceiling
    // before anything detectable exists.
    await new Promise((r) => setTimeout(r, 1500));

    const created = await create(pacedBase, pacedRoot.sid, 29, {
      "m2m:ts": { rn: uniqueRn("ts"), pei: 5000, mdd: true, mdn: 5, mdt: 1000 },
    });
    assert.equal(created.status, 201, `failed to create <ts>: ${created.raw?.slice(0, 200)}`);
    const sid = created.body["m2m:ts"].ri;

    // Long enough that any pass the <timeSeries> creation might have triggered is over and the
    // sweep is back on the ceiling. That leaves the <timeSeriesInstance> as the only thing that can
    // end the sleep, which is exactly the wake being pinned: a <timeSeries> has no anchor until its
    // first instance, so nothing before this point is detectable at all.
    await new Promise((r) => setTimeout(r, 1500));

    const t0 = Math.floor(Date.now() / 1000);
    await create(pacedBase, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: from_epoch_seconds(t0), con: "1" } });

    // The point expected at t0+5s is detectable at t0+6s.
    await new Promise((r) => setTimeout(r, 9000));
    const body = (await retrieve(pacedBase, sid)).body["m2m:ts"];
    assert.ok(body.mdc > 0,
      `a gap detectable at +6s must be reported by +9s even though the sweep interval is 300s; ` +
      `got mdc=${body.mdc} mdlt=${JSON.stringify(body.mdlt)}`);
    assert.ok(body.mdlt.includes(from_epoch_seconds(t0 + 5)),
      `the expected point at +5s must be listed: ${JSON.stringify(body.mdlt)}`);
  } finally {
    await pacedSrv.stop();
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${PACED_DB}`));
  }
});

test("switching missingDataDetect on catches up a resource that already has instances", async () => {
  // The other wake. A <timeSeries> can be created without detection, accumulate instances, and
  // have detection switched on later -- TS-0001:10.2.4.23 covers exactly that, including clearing
  // the recorded state on the false-to-true edge. At that moment points can already be overdue,
  // and the sweep is asleep on the ceiling because nothing was detecting when it booked the sleep.
  //
  // Same 300-second interval as the test above, for the same reason: nothing but the wake in
  // cse/resources/ts.js's update path can produce a detection inside it.
  //
  // TS-0018에 해당 TP 없음.
  const EDGE_DB = "mobius4_test_mdd_edge";
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${EDGE_DB}`);
    await c.query(`CREATE DATABASE ${EDGE_DB}`);
  });
  const edgeSrv = await startServer({
    dbName: EDGE_DB,
    cse: { missing_data_sweep_interval_seconds: 300 },
  });
  try {
    const edgeBase = edgeSrv.baseUrl;
    const edgeRoot = await createRoot(edgeBase, "edge");
    const created = await create(edgeBase, edgeRoot.sid, 29, {
      "m2m:ts": { rn: uniqueRn("ts"), pei: 5000, mdd: false, mdn: 5, mdt: 1000 },
    });
    assert.equal(created.status, 201, `failed to create <ts>: ${created.raw?.slice(0, 200)}`);
    const sid = created.body["m2m:ts"].ri;

    // Anchored well in the past, so several expected points are already overdue the moment
    // detection is switched on.
    const t0 = Math.floor(Date.now() / 1000) - 30;
    await create(edgeBase, sid, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: from_epoch_seconds(t0), con: "1" } });
    await new Promise((r) => setTimeout(r, 1500));

    const on = await update(edgeBase, sid, { "m2m:ts": { mdd: true } });
    assert.equal(on.status, 200, `failed to switch detection on: ${on.raw?.slice(0, 200)}`);

    await new Promise((r) => setTimeout(r, 3000));
    const body = (await retrieve(edgeBase, sid)).body["m2m:ts"];
    assert.ok(body.mdc > 0,
      `points overdue at the moment detection was switched on must be reported without waiting ` +
      `out the 300s interval; got mdc=${body.mdc} mdlt=${JSON.stringify(body.mdlt)}`);
  } finally {
    await edgeSrv.stop();
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${EDGE_DB}`));
  }
});
