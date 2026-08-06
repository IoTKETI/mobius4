"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { ADMIN } = require("./helpers/onem2m");

let srv;
// logLevel "info" so that the startup lines the third test reads are actually emitted;
// the helper drops to "error" by default.
before(async () => { srv = await startServer({ logLevel: "info" }); });
after(async () => { if (srv) await srv.stop(); });

test("the test-only instance starts up and serves the <CSEBase>", async () => {
  const res = await fetch(`${srv.baseUrl}/Mobius`, {
    headers: { "X-M2M-Origin": ADMIN, "X-M2M-RI": "boot1", "X-M2M-RVI": "3", Accept: "application/json" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-m2m-rsc"), "2000");
  const body = await res.json();
  assert.equal(body["m2m:cb"].rn, "Mobius");
});

test("uses a dynamic port, not the development port (7599)", () => {
  // It must never overlap with the development instance — an overlap means hitting the
  // development DB.
  assert.notEqual(srv.port, 7599);
  assert.ok(srv.port > 1024);
});

test("no HTTPS listener comes up unless it is asked for", () => {
  // Until v4.7.0 the https listener started unconditionally, reading certs/ca.crt, certs/wdc.key
  // and certs/wdc.crt at module load with no condition and no try/catch. A checkout without
  // those files could not start at all, which is what stopped `docker compose up` from being a
  // single command, and these tests had to allocate a second free port purely to keep the
  // listener off 7580.
  //
  // This asserts the new default from the outside: the startup log says the listener is off.
  // The suite as a whole is the wider proof — CI has no certs/ directory, so every one of these
  // tests only runs because starting no longer depends on one.
  assert.match(srv.diagnostics(), /HTTPS is disabled/,
    "the default configuration should start without TLS material");
  assert.doesNotMatch(srv.diagnostics(), /HTTPS server listening/);
});
