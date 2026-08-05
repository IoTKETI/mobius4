"use strict";
// TS-0009:6.2.2.1 — the mapping between the To parameter and the HTTP path component.
//
// The To parameter has three forms (CSE-Relative, SP-Relative, Absolute), each of which may
// carry a structured or an unstructured resource ID: six combinations, listed in table
// 6.2.2.1-1. The path component encodes which form is meant by its opening characters —
// "/~" for SP-Relative, "/_" for Absolute, and nothing for CSE-Relative — and the server
// "shall apply the reverse operations" to recover To. That reverse mapping lives in
// bindings/http.js:httpToPrim.
//
// All six are asserted here because the mapping had a defect that no single form revealed:
// the prefixes were matched with includes() rather than at the start of the path, so a
// resource named with a leading "_" pushed an ordinary CSE-Relative request down the
// Absolute branch. It was found through its symptom (a resource that could be created and
// then neither retrieved nor deleted) rather than through this table, which is the argument
// for pinning the table itself rather than only the symptom.
//
// The prefixes-only-at-the-start cases need a resource whose name begins with "_", which
// validation now refuses to create; those live in test/resource-name.test.js, where the row
// is written directly to the database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const config = require("config");
const { startServer } = require("./helpers/server");
const { create, retrieve, remove, createRoot, uniqueRn } = require("./helpers/onem2m");

// From config/default.json — test/helpers/server.js overrides only http, https, db, mqtt,
// logging and cse.admin, so these are the same values the server under test is using.
const SP_ID = config.get("cse.sp_id");         // "//mydomain.io"
const CSE_ID = config.get("cse.cse_id");       // "/Mobius4"

// The "//" of an M2M-SP-ID becomes the "/_" of the path: replacing the first "/" of To with
// "/_" is exactly what TS-0009:6.2.2.1 prescribes for the Absolute form.
const ABSOLUTE_PREFIX = `/_${SP_ID.slice(1)}`; // "/_/mydomain.io"

let srv, root, structured, unstructured;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "adr");

  const rn = uniqueRn("target");
  const res = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
  assert.equal(res.rsc, "2001", `setup failed: ${res.raw.slice(0, 200)}`);

  structured = `${root.sid}/${rn}`;               // Mobius/adr-.../target-...
  unstructured = res.body["m2m:cnt"].ri;          // the resourceID
});

after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
});

// Bypasses the helpers on purpose: they normalise the path, and what is under test here is
// precisely how a raw path component is read.
async function getByPath(path) {
  const res = await fetch(`${srv.baseUrl}${path}`, {
    method: "GET",
    headers: {
      "X-M2M-Origin": require("./helpers/onem2m").ADMIN,
      "X-M2M-RI": `adr-${Math.random().toString(36).slice(2)}`,
      "X-M2M-RVI": "3",
      Accept: "application/json",
    },
  });
  const raw = await res.text();
  return { rsc: res.headers.get("x-m2m-rsc"), body: raw ? JSON.parse(raw) : null, raw };
}

// The six rows of table 6.2.2.1-1. Each names the same resource by a different route, so
// every one of them must come back with the same representation.
test("all six To/path forms of table 6.2.2.1-1 reach the same resource", async () => {
  const forms = () => [
    ["structured CSE-Relative", `/${structured}`],
    ["unstructured CSE-Relative", `/${unstructured}`],
    ["structured SP-Relative", `/~${CSE_ID}/${structured}`],
    ["unstructured SP-Relative", `/~${CSE_ID}/${unstructured}`],
    ["structured Absolute", `${ABSOLUTE_PREFIX}${CSE_ID}/${structured}`],
    ["unstructured Absolute", `${ABSOLUTE_PREFIX}${CSE_ID}/${unstructured}`],
  ];

  for (const [label, path] of forms()) {
    const res = await getByPath(path);
    assert.equal(res.rsc, "2000", `${label} (${path}) should resolve: ${res.raw.slice(0, 200)}`);
    assert.equal(res.body["m2m:cnt"].ri, unstructured,
      `${label} should name the same resource as every other form`);
  }
});

test("an Absolute path bearing another SP's domain but this CSE's ID is still served locally", async () => {
  // cse/reqPrim.js:get_to_info accepts it deliberately: the CSE-ID is what identifies the
  // hosting CSE, and a request that names it has arrived where it belongs whatever domain the
  // Originator wrote. Asserted so that the intent is not mistaken for an oversight later.
  const res = await getByPath(`/_/other.example${CSE_ID}/${structured}`);
  assert.equal(res.rsc, "2000", `should be served locally: ${res.raw.slice(0, 200)}`);
  assert.equal(res.body["m2m:cnt"].ri, unstructured);
});

test("the Absolute and SP-Relative forms work for writes too, not only retrieval", async () => {
  // The reverse mapping runs once per request in httpToPrim, so a form that resolves for GET
  // resolves for the rest — but the reported defect was found on DELETE, and a mapping bug
  // that only bites the write path would be worth knowing about.
  const rn = uniqueRn("wr");
  const c = await create(srv.baseUrl, `~${CSE_ID}/${root.sid}`, 3, { "m2m:cnt": { rn } });
  assert.equal(c.rsc, "2001", `create via SP-Relative: ${c.raw.slice(0, 200)}`);

  const d = await remove(srv.baseUrl, `_${SP_ID.slice(1)}${CSE_ID}/${root.sid}/${rn}`);
  assert.equal(d.rsc, "2002", `delete via Absolute: ${d.raw.slice(0, 200)}`);

  const after_del = await retrieve(srv.baseUrl, `${root.sid}/${rn}`);
  assert.equal(after_del.rsc, "4004");
});
