"use strict";
// <AE> mandatory-attribute validation lives in the Joi schema, not in the handler.
//
// Two checks used to sit inside create_an_ae, one screen below the call that validates against
// ae_create_schema. One of them — "rr is missing" — was unreachable: the schema already declares
// rr as required and rejected it first (measured: the response said "rr => rr is required", not
// "rr is missing"). The other, the App-ID prefix rule, existed only there, so the schema a reader
// checks first did not describe what the CSE actually enforced.
//
// TS-0001:7.1.2 gives App-ID its 'N' (non-registered) / 'R' (registered) prefix.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { create, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
const { startServer } = require("./helpers/server");

let srv;

before(async () => {
  srv = await startServer();
});

after(async () => {
  if (srv) await srv.stop();
});

// AEs register under the <CSEBase>, and each needs its own name.
const ae = (over) => ({ "m2m:ae": { rn: uniqueRn("ae"), api: "Nx.test", rr: true, ...over } });

// Registered with no From, so the CSE assigns a fresh AE-ID each time. Sending the default test
// originator would derive the same AE-ID from it every time and the second registration would be
// refused 4117 ORIGINATOR_HAS_ALREADY_REGISTERED — a collision about the fixture, not the rule
// under test. The test database also persists between runs, so reusing one would fail on rerun.
const register = (body) => create(srv.baseUrl, CSE_BASE, 2, body, { originator: "" });

test("a well-formed registration is accepted", async () => {
  const res = await register(ae());
  assert.equal(res.rsc, "2001");
  assert.ok(res.body["m2m:ae"].aei, "an AE-ID is assigned");
});

test("a missing rr is refused by the schema", async () => {
  const body = ae();
  delete body["m2m:ae"].rr;

  const res = await register(body);
  assert.equal(res.rsc, "4000");
  assert.match(res.body["m2m:dbg"], /^rr =>/, "the message comes from the schema");
});

test("a missing api is refused by the schema", async () => {
  const body = ae();
  delete body["m2m:ae"].api;

  const res = await register(body);
  assert.equal(res.rsc, "4000");
  assert.match(res.body["m2m:dbg"], /^api =>/);
});

for (const api of ["Xbad", "nlower", "", "1N"]) {
  test(`api ${JSON.stringify(api)} is refused for not starting with N or R`, async () => {
    const res = await register(ae({ api }));
    assert.equal(res.rsc, "4000");
    assert.match(res.body["m2m:dbg"], /^api =>/, "reported against the api path, from the schema");
  });
}

for (const api of ["Nx.test", "Rx.test"]) {
  test(`api ${JSON.stringify(api)} is accepted`, async () => {
    const res = await register(ae({ api }));
    assert.equal(res.rsc, "2001");
  });
}

test("aei cannot be chosen by the requester", async () => {
  // The CSE assigns it; the schema forbids it in a request.
  const res = await register(ae({ aei: "CmineNow" }));
  assert.equal(res.rsc, "4000");
  assert.match(res.body["m2m:dbg"], /^aei =>/);
});
