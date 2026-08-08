"use strict";
// A generated resourceName has to be free.
//
// TS-0001:9.6.1.3.1 leaves the name to the Hosting CSE when the Originator does not provide one,
// and requires it to be unique among the children of the parent. mobius4 generated a random name
// and used it without looking. A collision was unlikely but produced the confusing kind of
// failure: the unique index on lookup.sid refused the insert and the client was told 4105
// CONFLICT about a name it never chose and could not change.
//
// The check does not make the assignment atomic — a concurrent create can still take the name
// between the check and the insert, and the unique index remains the real guard. It removes the
// ordinary collision, not the race.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { create, createRoot } = require("./helpers/onem2m");
const { startServer } = require("./helpers/server");

let srv, root;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "genrn");
});

after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
});

test("a create without rn gets a generated name of the expected shape", async () => {
  const res = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": {} });
  assert.equal(res.rsc, "2001");
  assert.match(res.body["m2m:cnt"].rn, /^cnt-\w+$/);
});

test("generated names do not repeat across many creates", async () => {
  // Not a probability test — with the configured random length a genuine collision is rare. What
  // it pins down is that nothing in the generation path hands back the same name twice in a row
  // (a seeded or cached generator would show up here immediately).
  const names = new Set();
  for (let i = 0; i < 30; i++) {
    const res = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": {} });
    assert.equal(res.rsc, "2001");
    names.add(res.body["m2m:cnt"].rn);
  }
  assert.equal(names.size, 30, "every generated name was distinct");
});

// Not covered by an automated test: the retry itself.
//
// Forcing a collision means shrinking config.length.rn_random until the namespace is small enough
// for one to happen, and at that size the test becomes probabilistic in both directions — it can
// pass on broken code and fail on correct code. A flaky test that occasionally accuses a working
// retry is worse than an honest gap, so the gap is written down instead.
//
// What is covered above is that the generated name is free in practice (the CSE accepts it) and
// that names do not repeat. What is not is the branch that runs when the first candidate is taken.
