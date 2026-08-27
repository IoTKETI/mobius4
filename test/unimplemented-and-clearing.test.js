"use strict";
// Four small defects that shared a shape: the CSE answered something other than what it meant.
//
// - A resource type it does not implement produced 5000 INTERNAL_SERVER_ERROR, which per
//   TS-0004:6.6.3.6 says the server broke rather than that the feature is absent (BACKLOG-018).
// - Clearing a <container>'s retention attributes was refused 4000 by validation, while the code
//   that would have cleared them sat behind that refusal looking correct (BACKLOG-046).
// - <dataset> and <datasetFragment> accepted a client CREATE that TR-0071 defines no procedure
//   for, and said 2001 (BACKLOG-090).
// - A <dataset> the CSE created itself notified nobody, while a <datasetFragment> created the same
//   way did (BACKLOG-097).
//
// TS-0018 has no test purpose for any of them: 018 and 046 are about answers the specification
// names but the TPs do not exercise, and 090/097 are TR-0071 territory, where the identifiers used
// are the project's own TP/TR-0071/... names (see test/ai-dataset-management.test.js). The
// assertions below therefore cite the core clauses per test rather than carrying an invented TP.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const config = require("config");
const { startServer } = require("./helpers/server");
const { create, retrieve, update, remove, createRoot, uniqueRn, CSE_BASE } = require("./helpers/onem2m");
// From its own module, not from cse/hostingCSE: requiring the CSE from a test process pulls in
// configuration that only exists inside a spawned server, and doing so passed locally while
// failing in CI with 'Configuration property "cse.admin" is not defined'.
const { NORM_RES_WITHOUT_ACPI } = require("../cse/parent-governed-types");

const SRT = config.get("cse.supported_resource_types");
const TY_SMD = 24; // <semanticDescriptor>
const TY_DAC = 34; // <dynamicAuthorizationConsultation>

let srv, root;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "unimpl");
});

after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
});

// --- BACKLOG-018: an unimplemented resource type ---------------------------------------------

test("the two unimplemented resource types are absent from the CSE's own srt", async () => {
  // The premise the answer is derived from, asserted rather than assumed. If either type is ever
  // implemented it goes into supported_resource_types, and this test failing is the reminder that
  // the ones below need rewriting rather than deleting.
  assert.ok(!SRT.includes(TY_SMD), "24 must not be advertised while cse/resources/smd.js is absent");
  assert.ok(!SRT.includes(TY_DAC), "34 must not be advertised while cse/resources/dac.js is absent");
});

for (const [ty, name] of [[TY_SMD, "<semanticDescriptor>"], [TY_DAC, "<dynamicAuthorizationConsultation>"]]) {
  test(`creating ${name} (ty=${ty}) answers 5001 NOT_IMPLEMENTED, not 5000`, async () => {
    // TS-0004:6.6.3.6 Table 6.6.3.6-1: 5000 is INTERNAL_SERVER_ERROR, 5001 is NOT_IMPLEMENTED.
    // The old answer was 5000 and it was not a decision — the dispatch arm called a module that
    // was never required, so the request died on a ReferenceError. A client cannot tell a CSE
    // that lacks a feature from one that is broken if both answer the same code, and the two call
    // for opposite responses: stop using the feature, or retry later.
    const res = await create(srv.baseUrl, root.sid, ty, { x: { rn: uniqueRn("u") } });

    assert.equal(res.rsc, "5001", `expected NOT_IMPLEMENTED: ${res.raw.slice(0, 200)}`);
    assert.notEqual(res.rsc, "5000", "5000 means the server broke, which is what this replaced");
  });
}

test("the TR-0071 AI/ML types still create, though they are absent from srt too", async () => {
  // The regression the first attempt at this fix caused, and the reason the guard names types
  // explicitly instead of deriving them from cse.supported_resource_types. srt is limited to
  // oneM2M-standard types on purpose, so 101-107 are not in it -- while being implemented and
  // client-creatable. Deriving "unimplemented" from srt refused every one of them with 5001.
  assert.ok(!SRT.includes(101), "the premise: <modelRepo> is not advertised in srt either");

  // <modelRepo> may not be a child of a <container> (its parents are cb/ae/csr), so this one goes
  // under the <CSEBase> and is removed here rather than with the rest of the tree.
  const rn = uniqueRn("mrp");
  const res = await create(srv.baseUrl, CSE_BASE, 101, { "m2m:mrp": { rn } });

  try {
    assert.equal(res.rsc, "2001", `<modelRepo> must still be creatable: ${res.raw.slice(0, 200)}`);
  } finally {
    if (res.rsc === "2001") await remove(srv.baseUrl, `${CSE_BASE}/${rn}`);
  }
});

test("a resource type that is not a oneM2M type at all is still a client error", async () => {
  // The boundary. NOT_IMPLEMENTED is a promise that the type exists in the standard and this CSE
  // does not serve it; a ty outside the standard is a malformed request instead, and the dispatch
  // switch's own default already answers it. Without this, widening the guard to "any ty not in
  // srt" would look equally correct and would start telling clients that 9999 is a oneM2M type.
  const res = await create(srv.baseUrl, root.sid, 9999, { x: { rn: uniqueRn("u") } });

  assert.notEqual(res.rsc, "5001", `9999 is not a oneM2M resource type: ${res.raw.slice(0, 200)}`);
});

// --- BACKLOG-046: clearing a <container>'s optional attributes --------------------------------

// The two groups mean different things and cse/resources/cnt.js has always distinguished them:
// acpi/lbl/loc are deleted, while mni/mbs/mia fall back to the deployment default rather than
// becoming unbounded.
const DEFAULTS = config.get("default.container");

test("mni, mbs and mia can be cleared, and fall back to the deployment default", async () => {
  const rn = uniqueRn("clr");
  const made = await create(srv.baseUrl, root.sid, 3, {
    "m2m:cnt": { rn, mni: 7, mbs: 1234, mia: 4321 },
  });
  assert.equal(made.rsc, "2001", `setup: ${made.raw.slice(0, 200)}`);
  const sid = `${root.sid}/${rn}`;

  for (const attr of ["mni", "mbs", "mia"]) {
    const res = await update(srv.baseUrl, sid, { "m2m:cnt": { [attr]: null } });
    assert.equal(res.rsc, "2004", `clearing ${attr} was refused: ${res.raw.slice(0, 200)}`);
  }

  const got = await retrieve(srv.baseUrl, sid);
  const cnt = got.body["m2m:cnt"];
  assert.equal(cnt.mni, DEFAULTS.mni, "mni should be the deployment default, not the value it had");
  assert.equal(cnt.mbs, DEFAULTS.mbs);
  assert.equal(cnt.mia, DEFAULTS.mia);
});

test("lbl and acpi can be cleared, and are gone rather than defaulted", async () => {
  const rn = uniqueRn("clr2");
  const made = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn, lbl: ["keep", "me"] } });
  assert.equal(made.rsc, "2001", `setup: ${made.raw.slice(0, 200)}`);
  const sid = `${root.sid}/${rn}`;

  const before = await retrieve(srv.baseUrl, sid);
  assert.deepEqual(before.body["m2m:cnt"].lbl, ["keep", "me"], "setup should have stored the labels");

  const cleared = await update(srv.baseUrl, sid, { "m2m:cnt": { lbl: null } });
  assert.equal(cleared.rsc, "2004", `clearing lbl was refused: ${cleared.raw.slice(0, 200)}`);

  const after = await retrieve(srv.baseUrl, sid);
  const lbl = after.body["m2m:cnt"].lbl;
  assert.ok(lbl === undefined || lbl === null || (Array.isArray(lbl) && lbl.length === 0),
    `lbl should be gone, not defaulted: ${JSON.stringify(lbl)}`);

  const acpiCleared = await update(srv.baseUrl, sid, { "m2m:cnt": { acpi: null } });
  assert.equal(acpiCleared.rsc, "2004", `clearing acpi was refused: ${acpiCleared.raw.slice(0, 200)}`);
});

test("a value of the wrong type is still refused — allow(null) is not allow(anything)", async () => {
  // What keeps the fix from being merely permissive. The change was one word per attribute, and
  // the word next to it would have been .any().
  const rn = uniqueRn("clr3");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
  const sid = `${root.sid}/${rn}`;

  const res = await update(srv.baseUrl, sid, { "m2m:cnt": { mni: "not a number" } });
  assert.equal(res.rsc, "4000", `a string mni must still be refused: ${res.raw.slice(0, 200)}`);
});

// --- BACKLOG-090: <dataset> and <datasetFragment> are not client-created ----------------------

for (const [ty, name] of [[106, "<dataset>"], [107, "<datasetFragment>"]]) {
  test(`a client CREATE of ${name} (ty=${ty}) is refused`, async () => {
    // TR-0071:7.2.3.2 and 7.2.3.3 define these as created by the Hosting CSE, with no Create
    // procedure over the API. The dispatch arms carried a comment saying exactly that — "this is
    // not called by client, temporary for testing" — and nothing enforced it.
    const res = await create(srv.baseUrl, root.sid, ty, {
      [ty === 106 ? "m2m:dts" : "m2m:dsf"]: { rn: uniqueRn("cli") },
    });

    assert.notEqual(res.rsc, "2001", `${name} accepted a direct client CREATE: ${res.raw.slice(0, 200)}`);
    assert.equal(res.rsc, "4005", `expected OPERATION_NOT_ALLOWED: ${res.raw.slice(0, 200)}`);
  });
}

// --- BACKLOG-043: which types are governed by their parent's policy ---------------------------

test("only types with no accessControlPolicyIDs of their own are decided by the parent", () => {
  // A list assertion rather than a behaviour one, and deliberately so: <schedule> was in this
  // list, mobius4 does not implement <schedule>, and therefore no request could reach the wrong
  // branch. Removing it changed nothing observable, which means no behaviour test could have
  // caught it going in either. What can be checked is the reading of the specification the list
  // encodes, so that is what this pins.
  //
  // TS-0001:9.6.1.3.2 splits on whether the type *has* the attribute, not on whether a given
  // resource left it empty. <contentInstance> (TS-0001:9.6.7) and <timeSeriesInstance>
  // (TS-0001:9.6.37) are both spelled "does not have its own accessControlPolicyIDs attribute"
  // and defer to the parent. <schedule> (TS-0001:9.6.9) has one, 0..1 RW — so an empty acpi there
  // means the default access policy (custodian, else the creator alone), not the parent's.
  //
  // Whoever implements <schedule> will meet this test before they meet the bug.
  assert.deepEqual([...NORM_RES_WITHOUT_ACPI].sort(), ["cin", "tsi"],
    "adding a type here means asserting TS-0001 gives it no accessControlPolicyIDs of its own");
});

// --- The CSE's explanation reaches the client ------------------------------------------------
//
// TS-0004:7.5.2 note 5 makes m2m:debugInfo "a plain text message which can optionally be included
// as debugging information in error responses"; TS-0004:7.2.1.2 lists it among the permitted
// Content values of a response; and TS-0009:6.5 maps Content to the message-body "for all
// primitives" bar two named exceptions, neither of which is any code below.
//
// Reported from the tr0071-ai-course lab: a <modelDeployment> refusal came back 406 with
// Content-Length: 0, while the CSE had computed the names of the exact features the dataset was
// missing. Four sites raise 5207 and all four build a message. The same held for 405 and for POST/
// PUT/DELETE's 404 — and this batch made it worse, because the <dataset> refusal added above is a
// 4005 whose text was being dropped on the way out.
//
// These assert the body, not the status: X-M2M-RSC was always right, which is why no existing test
// noticed. Each covers a different handler, since the branches were duplicated per handler and a
// single fix site would not have been enough.

test("a 406 NOT_ACCEPTABLE carries the reason it was refused (POST)", async () => {
  const rn = uniqueRn("tiny");
  const made = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn, mbs: 4 } });
  assert.equal(made.rsc, "2001", `setup: ${made.raw.slice(0, 200)}`);

  const res = await create(srv.baseUrl, `${root.sid}/${rn}`, 4,
    { "m2m:cin": { con: "far larger than four bytes" } });

  assert.equal(res.rsc, "5207", `expected NOT_ACCEPTABLE: ${res.raw.slice(0, 200)}`);
  assert.ok(res.body && res.body["m2m:dbg"],
    `the refusal must say why — this is the reported defect: ${JSON.stringify(res.raw)}`);
  assert.match(res.body["m2m:dbg"], /mbs|size/i);
});

test("a 405 OPERATION_NOT_ALLOWED carries its reason (POST)", async () => {
  // The one this batch created: the <dataset> refusal added above is a 4005, which maps to 405.
  const res = await create(srv.baseUrl, root.sid, 106, { "m2m:dts": { rn: uniqueRn("d") } });

  assert.equal(res.rsc, "4005");
  assert.ok(res.body && res.body["m2m:dbg"],
    `the refusal added in this same change was itself being dropped: ${JSON.stringify(res.raw)}`);
  assert.match(res.body["m2m:dbg"], /hosting CSE/);
});

test("a 404 carries its reason on POST, PUT and DELETE as it already did on GET", async () => {
  // GET's 404 branch already carried the body; the other three handlers ended bare, so the file
  // disagreed with itself about the same code.
  const missing = `${root.sid}/${uniqueRn("gone")}`;

  const posted = await create(srv.baseUrl, missing, 3, { "m2m:cnt": { rn: uniqueRn("c") } });
  assert.equal(posted.rsc, "4004");
  assert.ok(posted.body && posted.body["m2m:dbg"], `POST 404 body: ${JSON.stringify(posted.raw)}`);

  const put = await update(srv.baseUrl, missing, { "m2m:cnt": { lbl: ["x"] } });
  assert.equal(put.rsc, "4004");
  assert.ok(put.body && put.body["m2m:dbg"], `PUT 404 body: ${JSON.stringify(put.raw)}`);

  const deleted = await remove(srv.baseUrl, missing);
  assert.equal(deleted.rsc, "4004");
  assert.ok(deleted.body && deleted.body["m2m:dbg"], `DELETE 404 body: ${JSON.stringify(deleted.raw)}`);

  const got = await retrieve(srv.baseUrl, missing);
  assert.equal(got.rsc, "4004");
  assert.ok(got.body && got.body["m2m:dbg"], "GET 404 already carried it and must keep doing so");
});
