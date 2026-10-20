"use strict";
// Keeps the <CSEBase>'s pointOfAccess, supportedReleaseVersions, contentSerialization and
// supportedResourceType in step with configuration (poa/srv/csz) or with the implementation
// (srt) across restarts. TS-0018 has no test purpose for this -- there is no
// TP/oneM2M/CSE/REG/* identifier for re-syncing an existing <CSEBase> on a later boot -- so this
// is derived from the core specification instead:
//
//   TS-0001:9.6.3 -- pointOfAccess, contentSerialization, supportedReleaseVersions and
//   supportedResourceType are attributes of <CSEBase>, all RO (read-only to requesters). Their
//   source is not a request body; for poa/srv/csz it is the CSE's own configuration, and for
//   srt it is cse/resource-types.js's SUPPORTED_STANDARD_TYPES (DEC-137, mobius4-dev-tool --
//   srt is implementation fact, not configuration). Both are exactly what db/init.js's
//   sync_cb_with_config() now reads on every boot that finds the row already there.
//
// Reported scenario: an external team changed cse.poa (CSE_POA) and restarted, but the
// <CSEBase> kept the old pointOfAccess, because db/init.js only ever wrote poa/srv/csz once,
// the first time the row was created. srt had the same defect for a different reason
// (BACKLOG-137): v4.16.0 needed a hand-written SQL migration to add ty 29/30 to an existing
// <CSEBase>, and v4.5.0 added ty 28 with no migration at all, so deployments that predate it
// still answer an srt missing 28.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const config = require("config");
const { Client } = require("pg");
const { startServer } = require("./helpers/server");
const { retrieve, CSE_BASE } = require("./helpers/onem2m");
const { SUPPORTED_STANDARD_TYPES } = require("../cse/resource-types");

// Direct DB access to corrupt srt the way an upgrade-era deployment would have it -- a row
// written before some of SUPPORTED_STANDARD_TYPES existed, or hand-edited. Connects to the same
// mobius4_test database startServer() uses by default (test/helpers/server.js's TEST_DB),
// following the credential pattern test/helpers/two-cse.js's withPostgres() uses.
async function withTestDb(fn) {
  const client = new Client({
    host: config.get("db.host"),
    port: config.get("db.port"),
    user: config.get("db.user"),
    password: config.get("db.pw"),
    database: "mobius4_test",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function readCb(srv) {
  const res = await retrieve(srv.baseUrl, CSE_BASE);
  assert.equal(res.status, 200, `RETRIEVE Mobius failed: ${JSON.stringify(res.body)}`);
  return res.body["m2m:cb"];
}

test("the <CSEBase> picks up a changed cse.poa on the next restart", async (t) => {
  let srv;

  // mobius4_test persists across runs, so the <CSEBase> row may already exist from an earlier
  // test file or an earlier run of this one -- either db/init.js's create_cb() or its new
  // sync_cb_with_config() ends up writing poa A here, and this test does not need to know which.
  await t.test("boot with poa A leaves the <CSEBase> carrying poa A", async () => {
    srv = await startServer({ cse: { poa: ["http://127.0.0.1:1"] } });
    const cb = await readCb(srv);
    assert.deepEqual(cb.poa, ["http://127.0.0.1:1"]);
  });

  const csiAfterFirstBoot = (await readCb(srv)).csi;

  await t.test("restarting with poa B updates the existing <CSEBase> in place", async () => {
    await srv.stop();
    srv = await startServer({ cse: { poa: ["http://127.0.0.1:2"] } });
    const cb = await readCb(srv);
    assert.deepEqual(cb.poa, ["http://127.0.0.1:2"],
      "sync_cb_with_config() must overwrite the stale poa left by the previous boot");
    assert.equal(cb.csi, csiAfterFirstBoot,
      "csi must never change -- remote CSEs and AEs already registered against it");
  });

  // Leave the shared mobius4_test database the way other test files expect to find it: a
  // <CSEBase> matching config/default.json, not the throwaway poa values used above.
  await t.test("restarting again with the default configuration restores it", async () => {
    await srv.stop();
    srv = await startServer();
    const cb = await readCb(srv);
    assert.deepEqual(cb.poa, ["http://localhost:7599"]);
  });

  await srv.stop();
});

test("a corrupted srt is brought back to SUPPORTED_STANDARD_TYPES on the next restart", async (t) => {
  let srv;

  // A boot to get a <CSEBase> row in place, then corrupt its srt directly -- simulating the
  // upgrade scenario this whole mechanism exists for: a row written by an older version (or
  // hand-edited) that no longer matches what the running code implements.
  srv = await startServer();
  await srv.stop();

  await withTestDb((client) => client.query("UPDATE cb SET srt = ARRAY[1,2]::INTEGER[] WHERE ty = 5"));

  await withTestDb(async (client) => {
    const { rows } = await client.query("SELECT srt FROM cb WHERE ty = 5");
    assert.deepEqual(
      [...rows[0].srt].sort((a, b) => a - b),
      [1, 2],
      "fixture setup must actually corrupt srt before the restart"
    );
  });

  await t.test("restarting repairs srt", async () => {
    srv = await startServer();
    const cb = await readCb(srv);
    assert.deepEqual(
      [...cb.srt].sort((a, b) => a - b),
      [...SUPPORTED_STANDARD_TYPES].sort((a, b) => a - b),
      "sync_cb_with_config() must overwrite a stale srt with SUPPORTED_STANDARD_TYPES"
    );
  });

  // Leave mobius4_test the way other test files expect to find it.
  await t.test("restarting again with the default configuration still matches SUPPORTED_STANDARD_TYPES", async () => {
    await srv.stop();
    srv = await startServer();
    const cb = await readCb(srv);
    assert.deepEqual(
      [...cb.srt].sort((a, b) => a - b),
      [...SUPPORTED_STANDARD_TYPES].sort((a, b) => a - b)
    );
  });

  await srv.stop();
});
