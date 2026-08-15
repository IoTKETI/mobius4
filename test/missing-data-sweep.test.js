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

async function pollTs(sid, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = (await retrieve(base, sid)).body["m2m:ts"];
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for <ts> ${sid}; last seen ${JSON.stringify(last)}`);
}

// pei 2 / peid 0 / mdt 1 makes a gap detectable about three seconds after its expected time,
// which the ten-second anchor offset guarantees has already elapsed.
const DETECTING = { pei: 2, peid: 0, mdt: 1, mdd: true };

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

  const edited = await update(base, sid, { "m2m:ts": { pei: 300 } });
  assert.equal(edited.status, 400);
  assert.equal(edited.rsc, "4000"); // BAD_REQUEST

  const after = (await retrieve(base, sid)).body["m2m:ts"];
  assert.equal(after.mdd, true, "a refused update must not change mdd");
  assert.equal(after.pei, 2, "a refused update must not change pei");
  assert.equal(after.mdc, before.mdc, "a refused update must not clear the recorded state");
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

  const edited = await update(base, sid, { "m2m:ts": { pei: 300 } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body["m2m:ts"].mdd, false, "the edit must not itself resume detection");
  assert.equal(edited.body["m2m:ts"].mdc, 0);
  assert.equal(edited.body["m2m:ts"].pei, 300);
});

test("TS-0001:10.2.4.21 — detection runs only when pei is set and mdd is true", async () => {
  // "If the periodicInterval attribute is set and the missingDataDetect attribute is TRUE, the
  // Hosting CSE shall begin the procedure defined in clause 10.2.4.29."
  const noPei = (await create(base, root.sid, 29, {
    "m2m:ts": { rn: uniqueRn("ts"), mdd: true },
  })).body["m2m:ts"].ri;
  const noMdd = (await create(base, root.sid, 29, {
    "m2m:ts": { rn: uniqueRn("ts"), pei: 2, peid: 0, mdt: 1 },
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

  // The malformed resource itself never gets an anchor (the reduce that would set it throws
  // before the assignment), so it is skipped every tick rather than silently succeeding.
  const badBody = (await retrieve(base, bad)).body["m2m:ts"];
  assert.equal(badBody.mdc, 0, "the malformed resource itself is skipped, not silently processed");
});
