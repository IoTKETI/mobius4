"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { if (srv) await srv.stop(); });

test("the test-only instance starts up and serves the <CSEBase>", async () => {
  const res = await fetch(`${srv.baseUrl}/Mobius`, {
    headers: { "X-M2M-Origin": "SM", "X-M2M-RI": "boot1", "X-M2M-RVI": "3", Accept: "application/json" },
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

test("the HTTPS listener also uses a dynamic port, clear of the development port (7580)", () => {
  // bindings/http.js has no enabled flag for the https listener, so it always comes up —
  // without isolation it collides with 7580, which the development instance holds.
  assert.notEqual(srv.httpsPort, 7580);
  assert.notEqual(srv.httpsPort, srv.port);
});
