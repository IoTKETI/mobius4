"use strict";
// What RSC 2002 promises, and what happens to a request that arrives while it is being kept.
//
// DELETE used to answer 2002 with the removal still in flight: cse/hostingCSE.js called
// delete_resources() without awaiting it. A client that deleted a resource and retrieved it
// straight away could catch it half-gone, and the failure was not a stale read but a server
// error. set_ri_sid resolves the id and the type in two separate queries against the lookup
// table, so a DELETE committing between them yields an id with type 0; retrieve_a_res has no
// case for type 0 and leaves the content empty while still labelling the answer OK; and
// access_decision then throws reading that content. The client saw RSC 5000 for a resource
// that was simply gone. CI caught it once on Node 22; it reproduced locally about once in 300
// requests, on any Node version.
//
// The first test does not race anything. It writes the state the race produces — a lookup row
// whose type cannot be resolved — and asserts the answer, so the guard is checked every run
// rather than one run in five. A loop of real deletes was tried first and rejected: at 80
// rounds it failed to detect the defect in five consecutive runs, which is a two-second test
// that gates nothing.
//
// Descendants are out of scope here. delete_a_res removes them asynchronously by design, which
// is why the helpers carry waitForSubtreeGone; only the target of the request is covered.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const config = require("config");
const { startServer, TEST_DB } = require("./helpers/server");
const { create, remove, retrieve, discover, urils, createRoot, uniqueRn, CSE_BASE } = require("./helpers/onem2m");

let srv, root, db;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "del");

  // Same credentials the server uses, but the test database by name: config/default.json
  // points at the development database, and it is test/helpers/server.js that overrides
  // db.name for the child process.
  const { user, pw, host, port } = config.get("db");
  db = new Client({ user, password: pw, host, port, database: TEST_DB });
  await db.connect();
});

after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
  if (db) await db.end();
});

test("a resource whose type cannot be resolved is reported missing, not as a server error", async () => {
  // The lookup row below stands in for one that is midway through deletion. Type 0 is not a
  // oneM2M resource type; it is what get_ty_from_unstructuredID returns when the row it was
  // asked about is no longer there, so from set_ri_sid's point of view this is exactly the
  // state a concurrent DELETE leaves behind — an id that resolves and a type that does not.
  const rn = uniqueRn("ghost");
  const ri = `ghost${Date.now().toString(36)}`;
  const sid = `${CSE_BASE}/${rn}`;

  await db.query(
    "INSERT INTO lookup (ri, ty, rn, sid, lvl) VALUES ($1, 0, $2, $3, 2)",
    [ri, rn, sid]
  );

  try {
    const res = await retrieve(srv.baseUrl, sid);
    assert.equal(res.rsc, "4004",
      `an unresolvable target must read as absent, not as a fault: ${res.raw.slice(0, 200)}`);
  } finally {
    await db.query("DELETE FROM lookup WHERE ri = $1", [ri]);
  }
});

test("a retrieve issued right after 2002 reports the resource gone", async () => {
  const rn = uniqueRn("d");
  const c = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
  assert.equal(c.rsc, "2001", `setup failed: ${c.raw.slice(0, 200)}`);
  const sid = `${root.sid}/${rn}`;

  const d = await remove(srv.baseUrl, sid);
  assert.equal(d.rsc, "2002");

  const after_del = await retrieve(srv.baseUrl, sid);
  assert.equal(after_del.rsc, "4004");
});

test("the deleted resource is out of discovery by the time 2002 arrives", async () => {
  // The other half of the contract, reached by a different path: discovery reads the lookup
  // table directly rather than going through retrieve_a_res.
  const rn = uniqueRn("d");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
  const sid = `${root.sid}/${rn}`;

  const before_del = await discover(srv.baseUrl, root.sid);
  assert.ok(urils(before_del).includes(sid), "the resource should be discoverable before deletion");

  const d = await remove(srv.baseUrl, sid);
  assert.equal(d.rsc, "2002");

  const after_del = await discover(srv.baseUrl, root.sid);
  assert.ok(!urils(after_del).includes(sid),
    `2002 was returned while ${sid} was still discoverable`);
});
