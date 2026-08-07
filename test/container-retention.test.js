"use strict";
// <container> bookkeeping and retention, as TS-0004:7.4.7.2.1 specifies it.
//
// The clause imposes six things on creating a <contentInstance>, and each is asserted here:
//
//   step 1    content larger than maxByteSize or maxByteSizePerInstance is refused with
//             NOT_ACCEPTABLE; otherwise contentSize is set to the size in bytes of content
//   step 2 a  currentNrOfInstances exceeding maxNrOfInstances evicts the oldest
//   step 2 b  currentByteSize exceeding maxByteSize evicts the oldest, repeatedly, until the
//             maxByteSize condition is met
//   step 2 c  currentNrOfInstances is the count of <contentInstance> resources, and
//             currentByteSize the sum of their contentSize attributes
//   step 2 e  expirationTime is capped so that it is no more than maxInstanceAge past
//             creationTime, when the parent has one
//   step 3    the parent's stateTag is incremented and the value copied into the
//             <contentInstance>'s stateTag
//
// Why this file exists: cse/resources/cin.js is about to be rewritten for throughput (the
// three statements of its transaction collapsed into one), and none of these invariants had a
// test. The suite would have stayed green through a rewrite that silently stopped maintaining
// cni, or evicted the wrong instance, or double-counted cbs. Counters are the part of a CSE
// that goes wrong quietly: nothing fails, the numbers just drift.
//
// maxByteSizePerInstance and maxInstanceAge were added later (2026-08-07): mia was read from
// the parent and stored, but nothing compared it against et, and mbis did not exist at all —
// content bigger than a container's declared per-instance cap was accepted outright.
//
// Notification behaviour on eviction (step 2 d) lives in test/notification.test.js, next to
// the other subscription tests.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const config = require("config");
const { create, retrieve, update, remove, discover, urils, createRoot, uniqueRn } = require("./helpers/onem2m");
const { startServer, TEST_DB } = require("./helpers/server");

let srv, root, db;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "ret");

  const { user, pw, host, port } = config.get("db");
  db = new Client({ user, password: pw, host, port, database: TEST_DB });
  await db.connect();
});

after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
  if (db) await db.end();
});

// cse.timestamp_format is "YYYYMMDDTHHmmss", UTC, no offset. Returns epoch milliseconds.
function parseTs(s) {
  const y = s.slice(0, 4), mo = s.slice(4, 6), d = s.slice(6, 8);
  const h = s.slice(9, 11), mi = s.slice(11, 13), se = s.slice(13, 15);
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
}

// A fresh <container> per test — these assertions are about exact counters, so they cannot
// share one.
async function container(attrs = {}) {
  const rn = uniqueRn("c");
  const res = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn, ...attrs } });
  assert.equal(res.rsc, "2001", `setup failed: ${res.raw.slice(0, 200)}`);
  return `${root.sid}/${rn}`;
}

async function addCin(cntSid, con) {
  const res = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con } });
  return res;
}

async function readCnt(cntSid) {
  const res = await retrieve(srv.baseUrl, cntSid);
  assert.equal(res.rsc, "2000", `could not read the <container>: ${res.raw.slice(0, 200)}`);
  return res.body["m2m:cnt"];
}

// Every surviving <contentInstance> under a <container>, oldest first by creationTime.
async function liveCins(cntSid) {
  const res = await discover(srv.baseUrl, cntSid, { ty: "4" });
  assert.equal(res.rsc, "2000", `discovery failed: ${res.raw.slice(0, 200)}`);
  const out = [];
  for (const sid of urils(res)) {
    const r = await retrieve(srv.baseUrl, sid);
    if (r.rsc === "2000") out.push({ sid, ...r.body["m2m:cin"] });
  }
  return out;
}

// ── step 2 c: the counters mean what the clause says they mean ────────────────

test("cni counts the instances and cbs sums their contentSize", async () => {
  const cntSid = await container({ mni: 1000, mbs: 1000000 });

  let expected_cbs = 0;
  for (let i = 0; i < 5; i++) {
    const res = await addCin(cntSid, { v: "x".repeat(i * 3) });
    assert.equal(res.rsc, "2001", `create ${i} failed: ${res.raw.slice(0, 200)}`);
    expected_cbs += res.body["m2m:cin"].cs;
  }

  const cnt = await readCnt(cntSid);
  assert.equal(cnt.cni, 5, "cni is the count of <contentInstance> resources");
  assert.equal(cnt.cbs, expected_cbs, "cbs is the sum of the instances' cs");

  // Read the sum back from the stored resources rather than from the create responses, so a
  // cs that is reported to the client but not stored cannot pass.
  const stored = await liveCins(cntSid);
  assert.equal(stored.length, 5);
  assert.equal(stored.reduce((a, c) => a + c.cs, 0), cnt.cbs);
});

test("deleting a <contentInstance> takes it back out of cni and cbs", async () => {
  const cntSid = await container({ mni: 1000, mbs: 1000000 });
  const a = await addCin(cntSid, { v: "aaaa" });
  const b = await addCin(cntSid, { v: "bbbbbbbb" });
  assert.equal(a.rsc, "2001");
  assert.equal(b.rsc, "2001");

  const before_del = await readCnt(cntSid);
  const removed_cs = b.body["m2m:cin"].cs;

  const d = await remove(srv.baseUrl, `${cntSid}/${b.body["m2m:cin"].rn}`);
  assert.equal(d.rsc, "2002");

  const after_del = await readCnt(cntSid);
  assert.equal(after_del.cni, before_del.cni - 1);
  assert.equal(after_del.cbs, before_del.cbs - removed_cs,
    "cbs must drop by exactly the deleted instance's cs");
});

// ── step 1: maxByteSize refuses oversized content ─────────────────────────────

test("content larger than mbs is refused with 5207, and changes nothing", async () => {
  // 5207 is NOT_ACCEPTABLE (TS-0004:6.6.3.6), which is what step 1 a) calls for.
  const cntSid = await container({ mni: 1000, mbs: 20 });
  const seed = await addCin(cntSid, { v: "ok" });
  assert.equal(seed.rsc, "2001");
  const before_reject = await readCnt(cntSid);

  const res = await addCin(cntSid, { v: "y".repeat(500) });
  assert.equal(res.rsc, "5207", `expected NOT_ACCEPTABLE: ${res.raw.slice(0, 200)}`);

  // A refused create must not be half-applied. This is the assertion a rewrite is most likely
  // to break: moving the size check across the transaction boundary would leave the counters
  // advanced for an instance that was never stored.
  const after_reject = await readCnt(cntSid);
  assert.equal(after_reject.cni, before_reject.cni, "a refused create must not move cni");
  assert.equal(after_reject.cbs, before_reject.cbs, "a refused create must not move cbs");
  assert.equal((await liveCins(cntSid)).length, before_reject.cni);
});

test("content larger than mbis is refused with 5207, even when mbs would allow it", async () => {
  // mbis is a per-instance cap independent of mbs, the container's total budget — a container
  // can have room for the instance overall and still refuse this particular one for being too
  // big on its own. Until 2026-08-07 mbis did not exist in this codebase at all, so this
  // content was accepted.
  const cntSid = await container({ mni: 1000, mbs: 1000000, mbis: 20 });
  const before_reject = await readCnt(cntSid);

  const res = await addCin(cntSid, { v: "y".repeat(500) });
  assert.equal(res.rsc, "5207", `expected NOT_ACCEPTABLE: ${res.raw.slice(0, 200)}`);

  const after_reject = await readCnt(cntSid);
  assert.equal(after_reject.cni, before_reject.cni, "a refused create must not move cni");
  assert.equal(after_reject.cbs, before_reject.cbs, "a refused create must not move cbs");
});

test("content within mbis is accepted", async () => {
  const cntSid = await container({ mni: 1000, mbs: 1000000, mbis: 500 });
  const res = await addCin(cntSid, { v: "y".repeat(20) });
  assert.equal(res.rsc, "2001", `expected CREATED: ${res.raw.slice(0, 200)}`);
});

test("mbis round-trips on the <container>: set on create, changeable, clearable with null", async () => {
  const cntSid = await container({ mbis: 500 });
  assert.equal((await readCnt(cntSid)).mbis, 500);

  const upd = await update(srv.baseUrl, cntSid, { "m2m:cnt": { mbis: 900 } });
  assert.equal(upd.rsc, "2004", `update failed: ${upd.raw.slice(0, 200)}`);
  assert.equal((await readCnt(cntSid)).mbis, 900);

  // Unlike mni/mbs/mia, mbis has no deployment default (TS-0001:9.6.6 gives it none), so
  // sending null clears it rather than resetting it to one.
  const cleared = await update(srv.baseUrl, cntSid, { "m2m:cnt": { mbis: null } });
  assert.equal(cleared.rsc, "2004", `clearing update failed: ${cleared.raw.slice(0, 200)}`);
  assert.equal((await readCnt(cntSid)).mbis, undefined, "a cleared mbis must not be reported at all");
});

test("a <container> with no mbis accepts content of any size mbs allows", async () => {
  const cntSid = await container({ mni: 1000, mbs: 1000000 });
  const res = await addCin(cntSid, { v: "y".repeat(900) });
  assert.equal(res.rsc, "2001", `expected CREATED: ${res.raw.slice(0, 200)}`);
});

// ── step 2 e: maxInstanceAge caps expirationTime ───────────────────────────────

test("a <container> left at its default mia keeps content instances for about a year, not 30 days", async () => {
  // The deployment default for mia (config.default.container.mia) is what most containers get,
  // since cse/resources/cnt.js fills it in whenever a client does not send one. Before mia was
  // enforced at all, that default (once 2,592,000 seconds = 30 days) was inert: every instance
  // still got the far-future et default regardless. Enforcing mia without also revisiting that
  // default would have quietly cut every unconfigured container's content down to 30 days --
  // a real data-loss risk for anything that treats the container as its only copy. The default
  // now tracks the deployment's et default (12 months) instead, so this asserts the two stay in
  // step: not narrowed to anywhere near 30 days, and not so far off the 12-month et default that
  // the "track it" intent has drifted.
  const cntSid = await container({}); // no mia — takes the deployment default
  const res = await addCin(cntSid, { v: "default-lifetime" });
  assert.equal(res.rsc, "2001", `create failed: ${res.raw.slice(0, 200)}`);

  const cin = res.body["m2m:cin"];
  const diff = (parseTs(cin.et) - parseTs(cin.ct)) / 1000;
  const DAY = 24 * 3600;
  assert.ok(diff > 300 * DAY,
    `default mia must not shrink et anywhere near 30 days; got ${diff / DAY} days`);
  assert.ok(diff >= 365 * DAY - DAY && diff <= 366 * DAY + DAY,
    `default mia should track the ~12-month et default (365-366 days); got ${diff / DAY} days`);
});

test("maxInstanceAge caps et to ct + mia, overriding the deployment's far-future default", async () => {
  // With no client-supplied et, the default (get_default_et) is months out — see
  // config.default.common.et_month. mia has to win that comparison for this test to mean
  // anything, so it is picked small enough that no real deployment default could accidentally
  // already be shorter.
  const mia = 5;
  const cntSid = await container({ mia });
  const res = await addCin(cntSid, { v: "capped" });
  assert.equal(res.rsc, "2001", `create failed: ${res.raw.slice(0, 200)}`);

  const cin = res.body["m2m:cin"];
  const diff = (parseTs(cin.et) - parseTs(cin.ct)) / 1000;
  assert.equal(diff, mia, `et - ct must equal mia exactly when the default et is what got capped: got ${diff}s`);
});

test("a client-requested et shorter than the mia cap is kept, not extended out to it", async () => {
  const mia = 3600; // an hour — comfortably longer than the thirty seconds requested below
  const cntSid = await container({ mia });

  // Long enough that normal test/CI latency between reading ct and sending the create cannot
  // push it into the past (et must be in the future at request time) or past mia by accident,
  // short enough to stay unambiguously distinct from the hour-long mia above.
  const requestedSeconds = 30;
  const cnt = await readCnt(cntSid);
  const shortEt = new Date(parseTs(cnt.ct) + requestedSeconds * 1000)
    .toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");

  const res = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: "short" }, et: shortEt } });
  assert.equal(res.rsc, "2001", `create failed: ${res.raw.slice(0, 200)}`);
  assert.equal(res.body["m2m:cin"].et, shortEt,
    "a requested et shorter than mia allows must not be pushed out to the mia cap");
});

test("a <container> whose mia is actually absent in storage does not cap et", async () => {
  // Reachable only by writing NULL directly: cse/resources/cnt.js currently has no path that
  // stores mia as anything other than a number (create falls back to the deployment default,
  // and both of update's null-handling branches reset to that same default rather than
  // clearing the column — see the code map's R-2 note on this). So every container made
  // through the API carries a numeric mia, and the WRITE_CIN_SQL branch for "no cap" would be
  // untested by API-only means despite being a real branch of that query.
  const cntSid = await container({});
  const ri = (await readCnt(cntSid)).ri;
  await db.query("UPDATE cnt SET mia = NULL WHERE ri = $1", [ri]);

  const res = await addCin(cntSid, { v: "uncapped" });
  assert.equal(res.rsc, "2001", `create failed: ${res.raw.slice(0, 200)}`);

  const cin = res.body["m2m:cin"];
  const diff = (parseTs(cin.et) - parseTs(cin.ct)) / 1000;
  // Well past a year: with no mia to cap against at all, et must keep the deployment's
  // far-future default (12 calendar months) undisturbed, not merely stay under some cap.
  assert.ok(diff > 3600 * 24 * 300,
    `with no mia to cap against, et should keep its far-future default; got ${diff}s past ct`);
});

// ── step 2 a: mni eviction ────────────────────────────────────────────────────

test("exceeding mni evicts the oldest instance, and only the oldest", async () => {
  const cntSid = await container({ mni: 3, mbs: 1000000 });

  const made = [];
  for (let i = 1; i <= 3; i++) {
    const r = await addCin(cntSid, { seq: i });
    assert.equal(r.rsc, "2001");
    made.push(r.body["m2m:cin"].rn);
  }
  assert.equal((await readCnt(cntSid)).cni, 3, "at the limit, nothing is evicted yet");

  const fourth = await addCin(cntSid, { seq: 4 });
  assert.equal(fourth.rsc, "2001", "the create itself succeeds; it is the oldest that goes");
  made.push(fourth.body["m2m:cin"].rn);

  const cnt = await readCnt(cntSid);
  assert.equal(cnt.cni, 3, "cni stays at mni");

  // Identity, not just count: the first one is gone and the other three are present. A rewrite
  // that evicted by insertion order of the row rather than by age would still keep cni at 3.
  const survivors = (await liveCins(cntSid)).map((c) => c.rn);
  assert.equal(survivors.length, 3);
  assert.ok(!survivors.includes(made[0]), `the oldest (${made[0]}) should have been evicted`);
  for (const rn of made.slice(1)) {
    assert.ok(survivors.includes(rn), `${rn} should have survived`);
  }

  // And cbs is re-derived from the survivors, not left carrying the evicted instance's bytes.
  const sum = (await liveCins(cntSid)).reduce((a, c) => a + c.cs, 0);
  assert.equal(cnt.cbs, sum, "cbs must equal the sum over the survivors");
});

test("mni eviction keeps holding the line over many creates", async () => {
  // One eviction is a special case; a container used as a ring buffer is the normal one, and
  // it is where a counter that drifts by one per create becomes visible.
  const cntSid = await container({ mni: 5, mbs: 1000000 });
  for (let i = 0; i < 20; i++) {
    const r = await addCin(cntSid, { seq: i });
    assert.equal(r.rsc, "2001", `create ${i} failed: ${r.raw.slice(0, 200)}`);
  }

  const cnt = await readCnt(cntSid);
  const live = await liveCins(cntSid);
  assert.equal(cnt.cni, 5, "cni must not drift over repeated eviction");
  assert.equal(live.length, 5, "and the store must agree with the counter");
  assert.equal(cnt.cbs, live.reduce((a, c) => a + c.cs, 0), "nor may cbs drift");
});

// ── step 2 b: mbs eviction, "until the condition is met" ──────────────────────

test("exceeding mbs evicts repeatedly until the container is back within the limit", async () => {
  // The clause says "resources", plural, and "until maxByteSize conditions are met" — one
  // create can evict several. Sized so that the last create cannot fit until more than one of
  // the earlier instances is gone.
  const small = await container({ mni: 1000, mbs: 1000000 });
  const probe = await addCin(small, { v: "z".repeat(40) });
  assert.equal(probe.rsc, "2001");
  const unit = probe.body["m2m:cin"].cs;   // measured, not assumed — cs units are the CSE's

  const cntSid = await container({ mni: 1000, mbs: unit * 3 });
  for (let i = 0; i < 3; i++) {
    assert.equal((await addCin(cntSid, { v: "z".repeat(40) })).rsc, "2001");
  }
  const filled = await readCnt(cntSid);
  assert.equal(filled.cni, 3);

  // Roughly two units in one instance: fitting it has to displace at least two.
  const big = await addCin(cntSid, { v: "z".repeat(90) });
  assert.equal(big.rsc, "2001", `should be accepted, being under mbs: ${big.raw.slice(0, 200)}`);

  const cnt = await readCnt(cntSid);
  const live = await liveCins(cntSid);
  assert.ok(cnt.cbs <= cnt.mbs, `cbs (${cnt.cbs}) must be back within mbs (${cnt.mbs})`);
  assert.ok(cnt.cni < 4, `more than one instance should have been evicted, cni=${cnt.cni}`);
  assert.equal(cnt.cni, live.length, "counter and store must agree after multi-eviction");
  assert.equal(cnt.cbs, live.reduce((a, c) => a + c.cs, 0));
  assert.ok(live.some((c) => c.cs === big.body["m2m:cin"].cs),
    "the instance that triggered the eviction must itself be present");
});

// ── step 3: stateTag ──────────────────────────────────────────────────────────

test("creating a <contentInstance> increments the parent's st and copies it into the instance", async () => {
  const cntSid = await container({ mni: 1000, mbs: 1000000 });
  const before_create = (await readCnt(cntSid)).st;

  const res = await addCin(cntSid, { v: 1 });
  assert.equal(res.rsc, "2001");

  const after_create = await readCnt(cntSid);
  assert.equal(after_create.st, before_create + 1, "the parent's st advances by one");
  assert.equal(res.body["m2m:cin"].st, after_create.st,
    "and the instance carries that same value (TS-0004:7.4.7.2.1 step 3)");
});

// ── the rest of what a <contentInstance> create has to preserve ───────────────

test("optional attributes survive the write path, loc included", async () => {
  // Nothing else covers a <contentInstance> carrying loc, and it is the one attribute that
  // does not simply round-trip: it arrives as {typ, crd}, is converted to GeoJSON, and is
  // stored in a PostGIS geometry column. A write path rewritten to speak SQL directly has to
  // reproduce that conversion, and would otherwise drop the attribute in silence.
  const cntSid = await container({ mni: 1000, mbs: 1000000 });

  const res = await create(srv.baseUrl, cntSid, 4, {
    "m2m:cin": {
      con: { v: "located" },
      cnf: "application/json:0",
      lbl: ["a", "b"],
      loc: { typ: 1, crd: "[127.05,37.5]" },   // typ 1 is Point
    },
  });
  assert.equal(res.rsc, "2001", `create failed: ${res.raw.slice(0, 200)}`);

  const read = await retrieve(srv.baseUrl, `${cntSid}/${res.body["m2m:cin"].rn}`);
  assert.equal(read.rsc, "2000");
  const cin = read.body["m2m:cin"];

  assert.deepEqual(cin.lbl, ["a", "b"]);
  assert.equal(cin.cnf, "application/json:0");
  assert.deepEqual(cin.con, { v: "located" });
  assert.ok(cin.loc, "loc must come back");
  assert.equal(cin.loc.typ, 1, "the geometry type enum must survive");
  assert.deepEqual(JSON.parse(cin.loc.crd), [127.05, 37.5], "and so must the coordinates");
});

test("a <contentInstance> is discoverable by its own resourceID and by its parent", async () => {
  // The lookup row is written by the same code as the cin row. If a rewrite were to keep one
  // and lose the other, the resource would exist but be unreachable — the failure mode already
  // seen once this cycle with leading-underscore names.
  const cntSid = await container({ mni: 1000, mbs: 1000000 });
  const res = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: 1 } } });
  assert.equal(res.rsc, "2001");
  const { ri, rn } = res.body["m2m:cin"];

  const byRi = await retrieve(srv.baseUrl, ri);
  assert.equal(byRi.rsc, "2000", "unstructured (resourceID) addressing must work");

  const bySid = await retrieve(srv.baseUrl, `${cntSid}/${rn}`);
  assert.equal(bySid.rsc, "2000", "and so must the hierarchical path");
  assert.equal(bySid.body["m2m:cin"].ri, ri);

  const disc = await discover(srv.baseUrl, cntSid, { ty: "4" });
  assert.ok(urils(disc).includes(`${cntSid}/${rn}`), "and it must be discoverable");
});

// ── concurrency ───────────────────────────────────────────────────────────────

test("concurrent creates leave cni and cbs exact", async () => {
  // cni and cbs are maintained with SQL-side arithmetic (cni + 1, cbs + n), so they are
  // already safe against interleaving. Asserted because the rewrite this file precedes moves
  // that arithmetic, and losing the atomicity would show up here and nowhere else.
  const N = 20;
  const cntSid = await container({ mni: 1000, mbs: 1000000 });

  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => addCin(cntSid, { seq: i }))
  );
  const created = results.filter((r) => r.rsc === "2001");
  assert.equal(created.length, N, "all concurrent creates should succeed");

  const cnt = await readCnt(cntSid);
  const live = await liveCins(cntSid);
  assert.equal(cnt.cni, N);
  assert.equal(live.length, N);
  assert.equal(cnt.cbs, live.reduce((a, c) => a + c.cs, 0));
});

test("concurrent creates against a container at its limit all succeed", async () => {
  // Eviction runs on the write path, so a container held at mni is the case where creates and
  // evictions interleave. A rewrite that takes its locks in a different order from the write
  // itself deadlocks here and nowhere else — this exact test was written after a
  // single-statement eviction that passed every other assertion in this file failed a third of
  // its requests with "deadlock detected" under sustained load.
  //
  // The assertion is that every create is accepted. A create refused because the database
  // could not order two of its own statements is not a rejection the client can act on.
  // Sustained rather than a single burst: one wave of concurrent creates tends to get
  // serialised by the write's own lock on the container row and never overlaps two evictions.
  // Successive waves keep evictions in flight against each other, which is what surfaces it.
  const WAVES = 6, PER_WAVE = 24;
  const cntSid = await container({ mni: 5, mbs: 1000000 });

  // Fill to the limit first, so every one of the concurrent creates has to evict.
  for (let i = 0; i < 5; i++) {
    assert.equal((await addCin(cntSid, { seed: i })).rsc, "2001");
  }

  const byRsc = {};
  for (let w = 0; w < WAVES; w++) {
    const results = await Promise.all(
      Array.from({ length: PER_WAVE }, (_, i) => addCin(cntSid, { wave: w, seq: i }))
    );
    for (const r of results) byRsc[r.rsc] = (byRsc[r.rsc] || 0) + 1;
  }
  assert.deepEqual(byRsc, { 2001: WAVES * PER_WAVE },
    `every create should be accepted while eviction runs; got ${JSON.stringify(byRsc)}`);

  // And the container is still consistent afterwards.
  const cnt = await readCnt(cntSid);
  const live = await liveCins(cntSid);
  assert.equal(cnt.cni, live.length, "cni must agree with the store after concurrent eviction");
  assert.equal(cnt.cbs, live.reduce((a, c) => a + c.cs, 0));
  assert.ok(cnt.cni <= 5, `cni (${cnt.cni}) must be back within mni`);
});

test("concurrent creates give each instance a distinct st", async () => {
  // Carried as a todo when this file was written, against a measurement: 20 concurrent
  // creates produced 8 distinct st values, 11 of them sharing 1, while the parent correctly
  // reached 20. The old write path read the parent's st before opening its transaction and
  // wrote cin.st = that + 1, so concurrent creates copied the same value into several
  // instances — breaking TS-0004:7.4.7.2.1 step 3 and, more practically, leaving eviction
  // order ambiguous, since evict_if_needed picks the oldest with ORDER BY st ASC.
  //
  // The single-statement write dissolved it: st now comes back from the UPDATE that
  // incremented it, so there is no read to race. Promoted from todo to a real assertion.
  const N = 20;
  const cntSid = await container({ mni: 1000, mbs: 1000000 });

  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => addCin(cntSid, { seq: i }))
  );
  const sts = results.filter((r) => r.rsc === "2001").map((r) => r.body["m2m:cin"].st);
  assert.equal(new Set(sts).size, sts.length,
    `every instance should carry its own st, got ${JSON.stringify(sts.slice().sort((a, b) => a - b))}`);
});
