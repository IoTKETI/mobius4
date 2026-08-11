"use strict";
// What an expired resource does before the sweep deletes it.
//
// TS-0001:9.6.1.3.2 defines a resource as 'obsolete' from the moment expirationTime passes, and
// deletion as a separate thing the Hosting CSE does "after" that time — with no deadline. So there
// is always a window in which an obsolete row is still in the table, and the question these tests
// pin down is what the CSE does during it.
//
// Reported by mobius4-browser (2026-08-11): an expired <subscription> kept publishing
// notifications for the whole sweep interval, to a target that had gone away. Measured on 4.13.1
// before the fix — notification fired, RETRIEVE answered 2000, discovery listed it.
//
// No TS-0018 test purpose covers this. Searched `corpus/source/TS-0018/raw/` for expirationTime
// and for expiry-driven deletion: the TPs that name expirationTime all exercise setting or
// updating the attribute (TP/oneM2M/CSE/DMR/UPD/014_SUB/ET and its siblings), none exercises what
// happens once the time passes. The assertions below therefore come from the core clauses cited
// per test, and the TP identifiers are left off rather than invented.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const config = require("config");
const { startServer } = require("./helpers/server");
const {
  create, retrieve, remove, discover, urils, createRoot, uniqueRn, CSE_BASE,
} = require("./helpers/onem2m");
const { startSink, netOf } = require("./helpers/noti-sink");

// et has one-second resolution ("YYYYMMDDTHHmmss") and create_a_res refuses an et that is not
// strictly in the future, so a fixture cannot be born expired: it is created with a short life and
// waited out. TTL_S is the smallest value that is not flaky — 1 would race the truncation to the
// second, since an et 1.1s away formats to the very next second.
const TTL_S = 2;
const GRACE_MS = (TTL_S + 1) * 1000;

let srv, root, sink;

function etIn(seconds) {
  const d = new Date(Date.now() + seconds * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fixtures that have to age are all created up front and waited out once, so the file pays the
// grace period a single time rather than per test.
const fx = {};

before(async () => {
  srv = await startServer();
  sink = await startSink();
  root = await createRoot(srv.baseUrl, "expiry");

  // (a) a <container> with one expiring and one live subscription on it
  fx.cntSubs = `${root.sid}/${uniqueRn("c")}`;
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: fx.cntSubs.split("/").pop() } });
  fx.subDying = `${fx.cntSubs}/${uniqueRn("s")}`;
  fx.subLive = `${fx.cntSubs}/${uniqueRn("s")}`;
  fx.subNoEt = `${fx.cntSubs}/${uniqueRn("s")}`;
  await create(srv.baseUrl, fx.cntSubs, 23, {
    "m2m:sub": { rn: fx.subDying.split("/").pop(), nu: [sink.url], enc: { net: [3] }, nct: 1, et: etIn(TTL_S) },
  });
  await create(srv.baseUrl, fx.cntSubs, 23, {
    "m2m:sub": { rn: fx.subLive.split("/").pop(), nu: [sink.url], enc: { net: [3] }, nct: 1 },
  });
  // A subscription that never expires: et is nullable, and in SQL `et > now` is NULL rather than
  // true for those rows. If the expiry gate were written as a bare comparison it would silence
  // every no-expiry subscription in the deployment — the failure mode this fixture exists to catch.
  await create(srv.baseUrl, fx.subNoEt.replace(/\/[^/]+$/, ""), 23, {
    "m2m:sub": { rn: fx.subNoEt.split("/").pop(), nu: [sink.url], enc: { net: [3] }, nct: 1 },
  });

  // (b) a <container> whose only subscription is expiring, watching child deletion (net=4)
  fx.cntNet4 = `${root.sid}/${uniqueRn("c4")}`;
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: fx.cntNet4.split("/").pop() } });
  fx.victim = `${fx.cntNet4}/${uniqueRn("v")}`;
  await create(srv.baseUrl, fx.cntNet4, 3, { "m2m:cnt": { rn: fx.victim.split("/").pop() } });
  fx.sub4 = `${fx.cntNet4}/${uniqueRn("s4")}`;
  await create(srv.baseUrl, fx.cntNet4, 23, {
    "m2m:sub": { rn: fx.sub4.split("/").pop(), nu: [sink.url], enc: { net: [4] }, nct: 1, et: etIn(TTL_S) },
  });

  // (c) two <container>, because <latest> and <oldest> discriminate at opposite ends. Creation
  //     order sets st, which is what both order by. In cntLa the expiring instances are the
  //     *newest*, so an unfiltered <latest> returns an obsolete one and the test can tell the
  //     difference; in cntOl they are the *oldest*, for the same reason at the other end. Written
  //     the other way round, either test passes without the fix — measured: the first draft had
  //     the live instance newest in both, and the <latest> test was green against unfixed code.
  fx.cntLa = `${root.sid}/${uniqueRn("cla")}`;
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: fx.cntLa.split("/").pop() } });
  await create(srv.baseUrl, fx.cntLa, 4, { "m2m:cin": { con: { v: "alive" } } });
  await create(srv.baseUrl, fx.cntLa, 4, { "m2m:cin": { con: { v: "dead-newest" }, et: etIn(TTL_S) } });

  fx.cntOl = `${root.sid}/${uniqueRn("col")}`;
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: fx.cntOl.split("/").pop() } });
  await create(srv.baseUrl, fx.cntOl, 4, { "m2m:cin": { con: { v: "dead-oldest" }, et: etIn(TTL_S) } });
  await create(srv.baseUrl, fx.cntOl, 4, { "m2m:cin": { con: { v: "alive" } } });

  // (d) a <container> whose every <contentInstance> expires
  fx.cntAllDead = `${root.sid}/${uniqueRn("cd")}`;
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: fx.cntAllDead.split("/").pop() } });
  await create(srv.baseUrl, fx.cntAllDead, 4, { "m2m:cin": { con: { v: "gone" }, et: etIn(TTL_S) } });

  await sleep(GRACE_MS);
});

after(async () => {
  if (root) await root.remove();
  if (sink) await sink.stop();
  if (srv) await srv.stop();
});

// --- <subscription> -------------------------------------------------------------------------

test("an expired <subscription> does not notify", async () => {
  // The reported defect. TS-0004:7.5.1.2.2 does not list expirationTime among its steps, but a
  // notification is the one observable claim that a subscription is live, and TS-0001:9.6.1.3.2
  // has already called this resource obsolete. TS-0004:7.5.1.2.6 makes the same pairing explicit
  // for aggregation: "while the <group> resource has not expired" (DEC-094).
  await create(srv.baseUrl, fx.cntSubs, 4, { "m2m:cin": { con: { v: "after-expiry" } } });

  await sink.expectNone((i) => i.body?.["m2m:sgn"]?.sur === fx.subDying, { graceMs: 2000 });
});

test("a live <subscription> on the same parent still notifies", async () => {
  // The gate has to be narrow. Both subscriptions sit under the same <container> and are found by
  // the same query, so an over-broad predicate would take this one out with the expired one — and
  // the suite would still be green without this test.
  const got = await sink.waitFor(
    (i) => netOf(i) === 3 && i.body["m2m:sgn"].sur === fx.subLive,
    { timeoutMs: 5000 }
  );
  assert.equal(got.body["m2m:sgn"].nev.net, 3);
});

test("a <subscription> with no expirationTime still notifies", async () => {
  const got = await sink.waitFor(
    (i) => netOf(i) === 3 && i.body["m2m:sgn"].sur === fx.subNoEt,
    { timeoutMs: 5000 }
  );
  assert.equal(got.body["m2m:sgn"].nev.net, 3);
});

test("an expired <subscription> does not notify on child deletion either (net=4)", async () => {
  // net=4 reads the subscriptions of the deleted resource's *parent* through a separate query
  // (notify_parent_of_child_deletion), so it needs its own gate and its own test.
  await remove(srv.baseUrl, fx.victim);

  await sink.expectNone((i) => i.body?.["m2m:sgn"]?.sur === fx.sub4, { graceMs: 2000 });
});

test("an expired <subscription> is still retrievable and discoverable", async () => {
  // Deliberately unchanged, and here so the boundary is a decision rather than an oversight.
  // TS-0001:9.6.1.3.2 sets no deadline for the deletion, so a resource awaiting the sweep is not
  // a spec violation, and the reporting client uses discovery to find its own leftovers after a
  // crash. Only the notification and the <container> read paths were narrowed (DEC-095).
  const got = await retrieve(srv.baseUrl, fx.subDying);
  assert.equal(got.rsc, "2000");

  const found = await discover(srv.baseUrl, CSE_BASE, { ty: "23" });
  assert.ok(urils(found).includes(fx.subDying), "still discoverable until the sweep runs");
});

// --- obsolete <contentInstance> -------------------------------------------------------------

test("<latest> skips obsolete <contentInstance> and returns the newest live one", async () => {
  // TS-0001:10.2.4.4 treats a <container> whose content instances are all obsolete as one with
  // none — obsolete instances are not part of the content. Since maxInstanceAge is enforced by
  // capping et (WRITE_CIN_SQL in cse/resources/cin.js), serving them also meant mia went
  // unenforced on reads: <latest> returned content older than the container's own mia allows.
  const la = await retrieve(srv.baseUrl, `${fx.cntLa}/la`);
  assert.equal(la.rsc, "2000");
  assert.deepEqual(
    la.body["m2m:cin"].con,
    { v: "alive" },
    "the newest instance is obsolete, so <latest> is the newest one that is not"
  );
});

test("<oldest> skips obsolete <contentInstance> too", async () => {
  const ol = await retrieve(srv.baseUrl, `${fx.cntOl}/ol`);
  assert.equal(ol.rsc, "2000");
  assert.deepEqual(
    ol.body["m2m:cin"].con,
    { v: "alive" },
    "the oldest instance is obsolete, so <oldest> is the oldest one that is not"
  );
});

test("<latest> answers 4004 when every <contentInstance> is obsolete", async () => {
  const la = await retrieve(srv.baseUrl, `${fx.cntAllDead}/la`);
  assert.equal(la.rsc, "4004", "same answer as a <container> that never had one (TS-0001:10.2.4.4)");
});

test("rcn=4 omits obsolete <contentInstance> children", async () => {
  const res = await retrieve(srv.baseUrl, `${fx.cntLa}?rcn=4`);
  assert.equal(res.rsc, "2000");
  const cins = res.body["m2m:cnt"]["m2m:cin"] || [];
  assert.deepEqual(
    cins.map((c) => c.con.v).sort(),
    ["alive"],
    "the obsolete instance is not part of the child-resources result"
  );
});

test("fu=1 discovery still lists an obsolete <contentInstance>", async () => {
  // The other half of the same decision (DEC-095): the narrowing is scoped to the clause that
  // asks for it. A flat discovery result is how a client finds what it left behind.
  const found = await discover(srv.baseUrl, fx.cntAllDead, { ty: "4" });
  assert.equal(urils(found).length, 1, "the obsolete instance is still addressable");
});

// --- the sweep -----------------------------------------------------------------------------

test("the expired-resource sweep runs at startup, not only after a full interval", async () => {
  // setInterval alone fires first after a whole interval, so with the default of one day a
  // deployment that restarts more often than that never swept at all — and docker-compose.yml
  // sets `restart: unless-stopped`. Reported as "expired resources are reclaimed daily"; the
  // sweep had in fact run twice in two days of uptime and would have run zero times in two days
  // of daily restarts.
  //
  // Runs against a database of its own: the sweep is global, and pointing it at the shared test
  // database would delete the other fixtures in this file out from under the tests above.
  const SWEEP_DB = "mobius4_test_startup_sweep";
  const admin = new Client({
    host: config.get("db.host"), port: config.get("db.port"),
    user: config.get("db.user"), password: config.get("db.pw"), database: "postgres",
  });
  await admin.connect();
  let first, second;
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SWEEP_DB}`);
    await admin.query(`CREATE DATABASE ${SWEEP_DB}`);

    first = await startServer({ dbName: SWEEP_DB });
    const rn = uniqueRn("sweepme");
    const made = await create(first.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn, et: etIn(TTL_S) } });
    assert.equal(made.rsc, "2001");
    await sleep(GRACE_MS);

    // Still there: one process, and its next scheduled sweep is a day away.
    assert.equal(
      (await retrieve(first.baseUrl, `${CSE_BASE}/${rn}`)).rsc, "2000",
      "nothing should have swept it yet — that is the window the report describes"
    );
    await first.stop();
    first = null;

    // A restart is the event that now triggers a sweep.
    second = await startServer({ dbName: SWEEP_DB });
    const deadline = Date.now() + 10000;
    let rsc;
    for (;;) {
      rsc = (await retrieve(second.baseUrl, `${CSE_BASE}/${rn}`)).rsc;
      if (rsc === "4004" || Date.now() > deadline) break;
      await sleep(200);
    }
    assert.equal(rsc, "4004", "the startup sweep should have deleted it");
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    await admin.query(`DROP DATABASE IF EXISTS ${SWEEP_DB}`).catch(() => {});
    await admin.end();
  }
});
