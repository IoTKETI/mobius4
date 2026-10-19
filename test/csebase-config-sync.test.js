"use strict";
// Keeps the <CSEBase>'s pointOfAccess, supportedReleaseVersions and contentSerialization in
// step with configuration across restarts. TS-0018 has no test purpose for this -- there is no
// TP/oneM2M/CSE/REG/* identifier for re-syncing an existing <CSEBase> on a later boot -- so this
// is derived from the core specification instead:
//
//   TS-0001:9.6.3 -- pointOfAccess, contentSerialization and supportedReleaseVersions are
//   attributes of <CSEBase>, all RO (read-only to requesters). Their source is not a request
//   body; it is the CSE's own configuration, which is exactly what db/init.js's
//   sync_cb_with_config() now reads on every boot that finds the row already there.
//
// Reported scenario: an external team changed cse.poa (CSE_POA) and restarted, but the
// <CSEBase> kept the old pointOfAccess, because db/init.js only ever wrote poa/srv/csz once,
// the first time the row was created.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { retrieve, CSE_BASE } = require("./helpers/onem2m");

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
