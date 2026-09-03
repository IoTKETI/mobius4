"use strict";
// Partial retrieval with the attributeList (atrl) parameter.
//
// It never worked. bindings/http.js sets prim.pc = { atrl } from the query string and then, a few
// lines later, assigned the parsed HTTP body over it -- and express.json() hands back {} for a
// request with no body, which is truthy. So every RETRIEVE with ?atrl=... had its attribute list
// replaced by an empty Content before the request primitive left the binding, and the whole
// resource came back with a 2000. Nothing said the parameter had been ignored.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, createRoot, uniqueRn, ADMIN } = require("./helpers/onem2m");

let srv, root;

before(async () => { srv = await startServer(); root = await createRoot(srv.baseUrl, "atrl"); });
after(async () => { if (root) await root.remove(); if (srv) await srv.stop(); });

const H = { "X-M2M-Origin": ADMIN, "X-M2M-RVI": "4" };

test("atrl returns only the attributes named", async () => {
  const rn = uniqueRn("c");
  const made = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn, lbl: ["one"], mni: 5 } });
  assert.equal(made.rsc, "2001", `setup failed: ${made.raw.slice(0, 160)}`);

  const res = await fetch(`${srv.baseUrl}/${root.sid}/${rn}?atrl=lbl`,
    { headers: { ...H, "X-M2M-RI": "a1" } });
  const body = await res.json();
  assert.equal(res.headers.get("x-m2m-rsc"), "2000");
  assert.deepEqual(Object.keys(body["m2m:cnt"]), ["lbl"],
    `only lbl was asked for: ${JSON.stringify(body)}`);
  assert.deepEqual(body["m2m:cnt"].lbl, ["one"]);
});

test("atrl takes more than one attribute", async () => {
  const rn = uniqueRn("c");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn, lbl: ["two"], mni: 7 } });

  const res = await fetch(`${srv.baseUrl}/${root.sid}/${rn}?atrl=lbl%20mni`,
    { headers: { ...H, "X-M2M-RI": "a2" } });
  const body = await res.json();
  assert.deepEqual(Object.keys(body["m2m:cnt"]).sort(), ["lbl", "mni"]);
});

test("without atrl the whole resource still comes back", async () => {
  // The control. A change that made atrl work by always truncating would pass the tests above.
  const rn = uniqueRn("c");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn, lbl: ["three"] } });

  const res = await fetch(`${srv.baseUrl}/${root.sid}/${rn}`, { headers: { ...H, "X-M2M-RI": "a3" } });
  const body = await res.json();
  assert.ok(Object.keys(body["m2m:cnt"]).length > 5,
    `the full representation: ${Object.keys(body["m2m:cnt"])}`);
});
