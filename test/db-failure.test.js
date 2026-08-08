"use strict";
// What the CSE says when it can no longer read its database.
//
// Reported from a containerised deployment: with the database unavailable, `/health` still
// answered 200 and every oneM2M request came back **4004 "target resource does not exist"**. Both
// describe a healthy CSE holding an empty resource tree, which is not what was happening.
//
// The 4004 came from three lookup helpers in cse/hostingCSE.js that caught their own query errors
// and returned the value they also use for "no such row" (`null`, or `0` for the type). set_ri_sid
// reads that as "the resource is not there" and reqPrim answers 4004 — a failure to *read* the
// tree was reported as a fact *about* the tree. TS-0004:6.6.3.6 (Receiver error response class)
// puts a receiver-side failure at 5000 INTERNAL_SERVER_ERROR, and prim_handling already maps a
// thrown error to that, so the fix was to stop swallowing rather than to add error handling.
//
// How the outage is simulated, and why this way
// --------------------------------------------
// Starting against a missing database does not reproduce it: db/init.js fails and the process
// exits (verified 2026-08-08 — "Error: PostgreSQL connection failed" at db/init.js:50, main()
// aborts). The reported state is a database that goes away *after* startup, so these tests start
// normally and then drop the `lookup` table, which every request path reads. Queries then fail
// for real, in-process, deterministically, with the server still up.
//
// That is a narrower failure than an unreachable host — no connection timeout, no half-open
// socket — but it exercises the branch that matters: a query that raises instead of returning
// rows. It runs against a database of its own so that breaking the schema cannot affect the
// shared test database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const config = require("config");
const { request, CSE_BASE } = require("./helpers/onem2m");
const { startServer } = require("./helpers/server");

const BROKEN_DB = "mobius4_test_db_failure";

let srv;
let admin;

async function withAdmin(fn) {
  const client = new Client({
    host: config.get("db.host"),
    port: config.get("db.port"),
    user: config.get("db.user"),
    password: config.get("db.pw"),
    database: "postgres",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

before(async () => {
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${BROKEN_DB}`);
    await c.query(`CREATE DATABASE ${BROKEN_DB}`);
  });

  // db/init.js builds the schema on first boot, so the server comes up healthy first.
  srv = await startServer({ dbName: BROKEN_DB });

  // Sanity check before breaking anything: if this is not green the rest proves nothing.
  const before_break = await fetch(`${srv.baseUrl}/health`);
  assert.equal(before_break.status, 200, "the server must be healthy before the outage");
  assert.equal((await before_break.json()).db, "ok");

  admin = new Client({
    host: config.get("db.host"),
    port: config.get("db.port"),
    user: config.get("db.user"),
    password: config.get("db.pw"),
    database: BROKEN_DB,
  });
  await admin.connect();
  await admin.query("DROP TABLE lookup CASCADE");
});

after(async () => {
  if (admin) await admin.end();
  if (srv) await srv.stop();
  await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${BROKEN_DB}`));
});

test("/health reports 503 when the database cannot be read", async () => {
  // docker-compose.yml wires this endpoint as the container healthcheck, which is why it must not
  // answer 200 here — an orchestrator would keep an unusable container in rotation. It probes the
  // lookup table rather than `SELECT 1` so that a reachable database with a broken schema, which
  // is exactly this state, still fails the check.
  const res = await fetch(`${srv.baseUrl}/health`);

  assert.equal(res.status, 503, "503, not 500: the process is fine and the condition can clear");
  const body = await res.json();
  assert.equal(body.status, "unavailable");
  assert.equal(body.db, "unreachable");
});

test("a retrieve answers 5000, not 4004, when the database cannot be read", async () => {
  const res = await request(srv.baseUrl, { method: "GET", to: CSE_BASE });

  assert.equal(
    res.rsc,
    "5000",
    `expected INTERNAL_SERVER_ERROR, got ${res.rsc}. 4004 would tell the client the resource ` +
      `does not exist, which the CSE cannot know while it cannot read the tree`
  );
});

test("a create answers 5000 too", async () => {
  // The create path resolves its parent through the same helpers, so it failed the same way — and
  // a client retrying against a parent reported missing would have kept getting 4004.
  const res = await request(srv.baseUrl, {
    method: "POST",
    to: CSE_BASE,
    ty: 3,
    body: { "m2m:cnt": { rn: "should-not-be-created" } },
  });

  assert.equal(res.rsc, "5000");
});

test("a delete answers 5000 too", async () => {
  const res = await request(srv.baseUrl, { method: "DELETE", to: `${CSE_BASE}/anything` });

  assert.equal(res.rsc, "5000");
});
