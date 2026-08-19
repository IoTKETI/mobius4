"use strict";
// Regression: the `cr` (creator) filter criterion of discovery.
//
// set_where_clause had `if (cr) { where.rn = rn; }` — filtering by creator wrongly assigned the
// (undefined) rn, so a cr-filtered discovery raised an internal error (rsc 5000) instead of
// matching on the creator column. TS-0004:7.3.3.17.9 lists `creator` as a filter criterion; every
// per-type table carries a `cr` column (db/init.js), so the condition belongs in the shared
// WHERE. This test creates two resources — one whose creator attribute is stored, one without —
// and asserts a cr filter returns only the former.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, discover, urils, createRoot, uniqueRn } = require("./helpers/onem2m");

let srv, root, withCrSid, creatorValue;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "crf");

  // `cr: null` in the create body is how an originator asks for the creator attribute to be set;
  // the cnt create then stores the originator in the cr column (cse/resources/cnt.js). Without it
  // the cr column stays NULL.
  const withCrRn = uniqueRn("hascr");
  const a = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: withCrRn, cr: null } });
  withCrSid = `${root.sid}/${withCrRn}`;
  creatorValue = a.body["m2m:cnt"].cr; // the value actually stored, no hardcoding
  assert.ok(creatorValue, `expected a stored creator, got ${JSON.stringify(a.body["m2m:cnt"])}`);

  // second container with no creator attribute
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: uniqueRn("nocr") } });
});

after(async () => { if (root) await root.remove(); if (srv) await srv.stop(); });

test("cr filter returns only resources with the matching creator", async () => {
  const res = await discover(srv.baseUrl, root.sid, { cr: creatorValue });
  assert.equal(res.rsc, "2000", `cr filter must not error (was ${res.rsc})`);
  assert.deepEqual(urils(res), [withCrSid]);
});

test("cr filter with an unknown creator returns nothing", async () => {
  const res = await discover(srv.baseUrl, root.sid, { cr: "no-such-originator" });
  assert.equal(res.rsc, "2000");
  assert.deepEqual(urils(res), []);
});
