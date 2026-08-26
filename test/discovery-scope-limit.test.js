"use strict";
// A discovery scoped to a resource is not truncated by rows that live elsewhere in the CSE.
//
// cse.discovery_limit caps how many rows *per type* discovery_core reads out of each table. The
// cap is a protective bound on the database read, not a property of the request: TS-0001:8.1.2
// gives filterCriteria a `lim`, and that is what a client controls. Whether the cap can swallow
// a resource the client asked about therefore depends entirely on where it is applied -- before
// or after the subtree condition.
//
// It is applied after, in SQL: set_where_clause puts `sid LIKE 'target/%'` on every per-type
// query and the LIMIT rides on top of it (cse/hostingCSE.js). So a discovery rooted at a
// container reads at most 200 rows *of that container's subtree*, and what other tests, other
// runs, or other tenants left in the same table cannot displace them.
//
// This file exists because the suite could not tell the difference. Every test shared one
// database that was never reset, cleanup is best-effort by design (see scripts/reset-test-db.js),
// and rows accumulated across runs -- measured 2026-08-26: 6804 lookup rows, 236 <subscription>,
// against a cap of 200. One assertion in test/expiry.test.js discovered from the <CSEBase> and
// checked that its own fixture came back, which by then was a claim about the whole database. It
// passed only because discovery has been newest-first since v4.15.1 and the fixture was fresh.
//
// So the suite now resets its database, and this file pins the property that made the <CSEBase>
// form the wrong one to write: scoping survives saturation, and a <CSEBase>-wide discovery is
// the one that does not. Rather than create 200 resources to reach the real cap, the server
// under test is started with cse.discovery_limit set to 2 -- the cap is the same code path at
// any value, and a test that takes a second to run is one that keeps being run.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, discover, urils, createRoot, uniqueRn, CSE_BASE } = require("./helpers/onem2m");

// Deliberately far below the number of resources this file creates, so every query in it is
// saturated. With the default 200 nothing here would be cut and the file would assert nothing.
const TINY_LIMIT = 2;
const SIBLINGS = 6;

let srv, root, target, targetSid, siblingSids = [];

before(async () => {
  srv = await startServer({ cse: { discovery_limit: TINY_LIMIT } });
  root = await createRoot(srv.baseUrl, "dsl");

  // The subtree whose discovery must stay correct: one container holding two children.
  target = uniqueRn("target");
  targetSid = `${root.sid}/${target}`;
  const t = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: target } });
  assert.equal(t.rsc, "2001", `setup, target: ${t.raw.slice(0, 200)}`);
  for (const child of ["a", "b"]) {
    const c = await create(srv.baseUrl, targetSid, 3, { "m2m:cnt": { rn: `${target}-${child}` } });
    assert.equal(c.rsc, "2001", `setup, child ${child}: ${c.raw.slice(0, 200)}`);
  }

  // Noise elsewhere in the CSE, created *after* the target so that a newest-first read of the
  // whole table returns these and not the target's subtree. This is the part that makes the
  // test able to fail: with the ordering alone the target would still surface.
  for (let i = 0; i < SIBLINGS; i++) {
    const rn = uniqueRn("noise");
    const n = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
    assert.equal(n.rsc, "2001", `setup, noise ${i}: ${n.raw.slice(0, 200)}`);
    siblingSids.push(`${root.sid}/${rn}`);
  }
});

after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
});

test("a scoped discovery returns the target's own subtree, not the newest rows in the table", async () => {
  const list = urils(await discover(srv.baseUrl, targetSid, { ty: "3" }));

  // Two children, and the cap is 2 -- so this is the boundary case where the subtree exactly
  // fills the budget. Nothing from outside may take a slot in it.
  assert.deepEqual(
    [...list].sort(),
    [`${targetSid}/${target}-a`, `${targetSid}/${target}-b`].sort(),
    `a scoped discovery must not be displaced by rows outside the scope: ${JSON.stringify(list)}`,
  );
  for (const noise of siblingSids) {
    assert.ok(!list.includes(noise), `${noise} is outside the scope and must not appear`);
  }
});

test("the <CSEBase>-wide discovery is the one the cap can truncate", async () => {
  // The counterpart, asserted rather than assumed: this is why a test must not check for its own
  // fixture in a <CSEBase>-wide result. Under a cap of 2 the CSE holds far more than 2
  // containers, so the read is cut and the target's subtree is not in it.
  const list = urils(await discover(srv.baseUrl, CSE_BASE, { ty: "3" }));

  assert.equal(list.length, TINY_LIMIT, `the per-type cap should bound this read: ${JSON.stringify(list)}`);
  assert.ok(
    !list.includes(`${targetSid}/${target}-a`),
    "a truncated CSEBase-wide read is exactly the situation this file documents; if this ever " +
      "stops holding, the cap has moved and the scoping test above needs rereading",
  );
});

test("lim below the cap still bounds the result, and scoping still holds", async () => {
  // `lim` is the client's control (TS-0004:7.3.3.17.14) and rides inside the same budget. A
  // scoped request with lim=1 must return one of the target's children -- not one of the noise
  // containers that a whole-table read would have reached first.
  const list = urils(await discover(srv.baseUrl, targetSid, { ty: "3", lim: "1" }));

  assert.equal(list.length, 1, `lim=1 should return exactly one: ${JSON.stringify(list)}`);
  assert.ok(
    list[0].startsWith(`${targetSid}/`),
    `the single result must come from the scope: ${list[0]}`,
  );
});
