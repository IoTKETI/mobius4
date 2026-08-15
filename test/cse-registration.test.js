"use strict";
// Registration conformance, taken from the test purposes in TS-0018 clause 7.2.2.2
// (TP/oneM2M/CSE/REG/...). Each test names the TP it implements; the assertions are the TP's
// "Expected behaviour" and nothing else, so that a failure here reads as a conformance failure
// rather than as a disagreement with a scenario someone made up.
//
// This file holds the CF01 test purposes only — one CSE, with the test system acting as an AE
// (TS-0018 clause 5.1, figure 5.1-1). The CF04 ones (two CSEs, <remoteCSE>) are in
// test/cse-registration-remote.test.js because they cannot be run against a single server.
//
// Test purposes deliberately not implemented
// ------------------------------------------
// - CRE/004, CRE/016, CRE/032 — App-ID / AE-ID-Stem rule validation against the
//   <serviceSubscribedAppRule> resources linked from <serviceSubscribedNode>, answering 4126
//   APP_RULE_VALIDATION_FAILED. mobius4 has no service subscription support at all (no ty=19,
//   no ty=14, no 4126 anywhere in cse/), and per the project owner's decision on 2026-08-08
//   there is no plan to add it. These three TPs are therefore out of scope, not pending.
// - CRE/003, CRE/005..CRE/010 — AE registration involving <AEAnnc> on an IN-CSE, i.e. the 'S'
//   AE-ID-Stem announcement flow of TS-0001:10.2.2.2 cases a/b/e. Announcement is not
//   implemented in mobius4 (grep -ri announce over cse/ finds nothing), and the same service
//   subscription decision covers the verification these TPs turn on.
// - CRE/009 — CF03, where the IUT is an ADN-AE. mobius4 is a CSE; not applicable.
//
// Where this file departs from a TP, and why
// ------------------------------------------
// CRE/023 expects 4105 (CONFLICT) when an AE re-registers with an AE-ID-Stem that is already in
// use. mobius4 answers 4117 ORIGINATOR_HAS_ALREADY_REGISTERED, and TS-0004:7.4.5.2.1 is explicit
// about that being the right one: "The Hosting CSE shall check for the presence of any resources
// having an AE-ID that matches the one specified in the request ... If such a resource exists,
// then the Hosting CSE shall reject the request with a Response Status Code indicating an
// 'ORIGINATOR_HAS_ALREADY_REGISTERED' error." TS-0001:10.2.2.2 step 004 only says "shall respond
// with an error" without naming one. So the protocol specification and the test suite disagree,
// and this test follows the protocol specification. Raised with the project owner as a spec
// question — if a certification body runs CRE/023 as written, mobius4 fails it on a point where
// TS-0004 says mobius4 is right.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { CSE_BASE, request, create, retrieve, update, remove, uniqueRn } = require("./helpers/onem2m");
const { startServer } = require("./helpers/server");

let srv;

before(async () => {
  srv = await startServer();
});

after(async () => {
  if (srv) await srv.stop();
});

// A minimal registration body: api and rr are the only mandatory attributes (TS-0001 table
// 9.6.5-2), and rn keeps registrations from colliding across runs — the test database persists.
const aeBody = (over = {}) => ({ "m2m:ae": { rn: uniqueRn("reg"), api: "Nreg.test", rr: true, ...over } });

// `from` is the From parameter, which for AE registration carries the AE-ID-Stem or the single
// character 'C'/'S', or is absent (TS-0001:10.2.2.2 step 002 cases i..v).
const register = (body, from) => create(srv.baseUrl, CSE_BASE, 2, body, { originator: from ?? "" });

// A registration that must succeed, returning the created AE. Used where the registration is
// the fixture rather than the thing under test.
async function registerOk(body, from) {
  const res = await register(body, from);
  assert.equal(res.rsc, "2001", `fixture registration failed: ${res.raw.slice(0, 200)}`);
  return res.body["m2m:ae"];
}

// ---------------------------------------------------------------------------
// 7.2.2.2.2 RETRIEVE — <CSEBase>
// ---------------------------------------------------------------------------

test("TP/oneM2M/CSE/REG/RET/001 — a <CSEBase> RETRIEVE is answered 2000 with the CSEBase representation", async () => {
  const ae = await registerOk(aeBody());

  const res = await retrieve(srv.baseUrl, CSE_BASE, { originator: ae.aei });

  assert.equal(res.rsc, "2000");
  assert.ok(res.body["m2m:cb"], `expected a CSEBase representation, got ${res.raw.slice(0, 200)}`);
});

test("TP/oneM2M/CSE/REG/RET/002_CST — the <CSEBase> carries its cseType", async () => {
  const ae = await registerOk(aeBody());

  const cb = (await retrieve(srv.baseUrl, CSE_BASE, { originator: ae.aei })).body["m2m:cb"];

  assert.ok(cb.cst !== undefined, "cseType (cst) is absent from the <CSEBase>");
});

test("TP/oneM2M/CSE/REG/RET/005 — the <CSEBase> reports cseType 1 (IN_CSE)", async () => {
  // The test instance runs with config/default.json's cse_type, which is 1. A deployment that
  // sets cse_type to 2 or 3 would legitimately answer differently; this asserts what this
  // configuration must say, not a universal truth.
  const ae = await registerOk(aeBody());

  const cb = (await retrieve(srv.baseUrl, CSE_BASE, { originator: ae.aei })).body["m2m:cb"];

  assert.equal(cb.cst, 1);
});

test("TP/oneM2M/CSE/REG/RET/008 — the <CSEBase> carries supportedResourceType and pointOfAccess", async () => {
  const ae = await registerOk(aeBody());

  const cb = (await retrieve(srv.baseUrl, CSE_BASE, { originator: ae.aei })).body["m2m:cb"];

  assert.ok(Array.isArray(cb.srt) && cb.srt.length > 0, `srt missing or empty: ${JSON.stringify(cb.srt)}`);
  assert.ok(Array.isArray(cb.poa) && cb.poa.length > 0, `poa missing or empty: ${JSON.stringify(cb.poa)}`);
  // config/default.json's cse.supported_resource_types must actually include <timeSeries> (29)
  // and <timeSeriesInstance> (30), or a deployment advertises support it does not have (finding 1,
  // db/init.js's create_cb path -- see db/migrations/v4.16.0.sql for the matching upgrade path on
  // a <CSEBase> that already existed before ty 29/30 shipped). A fresh test database always goes
  // through create_cb, so this only exercises that path, not the migration's UPDATE.
  assert.ok(cb.srt.includes(29), `srt must include 29 (<timeSeries>): ${JSON.stringify(cb.srt)}`);
  assert.ok(cb.srt.includes(30), `srt must include 30 (<timeSeriesInstance>): ${JSON.stringify(cb.srt)}`);
});

// ---------------------------------------------------------------------------
// 7.2.2.2.2 RETRIEVE — <AE>
// ---------------------------------------------------------------------------

test("TP/oneM2M/CSE/REG/RET/003 — an <AE> RETRIEVE is answered 2000 with the AE representation", async () => {
  const body = aeBody();
  const ae = await registerOk(body);

  const res = await retrieve(srv.baseUrl, `${CSE_BASE}/${body["m2m:ae"].rn}`, { originator: ae.aei });

  assert.equal(res.rsc, "2000");
  assert.equal(res.body["m2m:ae"].aei, ae.aei);
});

// RET/004 is parameterized over the optional attributes of <AE> (TS-0001 clause 9.6.5): the TP
// body reads "_ATTRIBUTE_" and the table under it expands to _LBL, _APN, _POA, _NL, _CSZ. NL
// (nodeLink) is left out: it is set by the CSE from a <node> resource, which mobius4 does not
// implement, so there is no way to register an AE that has one.
const RET_004 = [
  ["LBL", "lbl", ["reg-test", "ret-004"]],
  ["APN", "apn", "registration-test-app"],
  ["POA", "poa", ["http://127.0.0.1:1/notify"]],
  // m2m:serializations is a list of m2m:permittedMediaTypes, whose XSD enumeration is
  // xml/json/cbor (corpus/schema/TS-0004/CDT-commonTypes.xsd:272-288) — the bare tokens, not
  // media type strings. "application/json" is not a legal value.
  ["CSZ", "csz", ["json"]],
];

for (const [suffix, attr, value] of RET_004) {
  test(`TP/oneM2M/CSE/REG/RET/004_${suffix} — an <AE> RETRIEVE returns its ${attr}`, async () => {
    const body = aeBody({ [attr]: value });
    const ae = await registerOk(body);

    const got = (await retrieve(srv.baseUrl, `${CSE_BASE}/${body["m2m:ae"].rn}`, { originator: ae.aei }))
      .body["m2m:ae"];

    assert.deepEqual(got[attr], value);
  });
}

// ---------------------------------------------------------------------------
// 7.2.2.2.1 CREATE — <AE> registration
// ---------------------------------------------------------------------------

test("TP/oneM2M/CSE/REG/CRE/001_CAE — a registration with a pre-provisioned C-AE-ID-Stem in From is accepted and keeps that stem", async () => {
  // TS-0001:10.2.2.2 step 002 case ii, resolved by step 004 case d: the Registrar CSE uses the
  // AE-ID-Stem from From as the Unstructured-CSE-relative-Resource-ID.
  const stem = `C${uniqueRn("pre").replace(/-/g, "")}`;

  const res = await register(aeBody(), stem);

  assert.equal(res.rsc, "2001");
  assert.equal(res.body["m2m:ae"].aei, stem, "the pre-provisioned stem must be the assigned AE-ID");
});

test("TP/oneM2M/CSE/REG/CRE/001_SAE — a registration with a pre-provisioned S-AE-ID-Stem in From is accepted", async () => {
  // PICS_IN_CSE. TS-0001:10.2.2.2 notes the <AEAnnc> steps "shall not be required when Registrar
  // CSE is the IN-CSE", which this instance is (cst=1), so the S case reduces to the local one.
  const stem = `S${uniqueRn("pre").replace(/-/g, "")}`;

  const res = await register(aeBody(), stem);

  assert.equal(res.rsc, "2001");
  assert.equal(res.body["m2m:ae"].aei, stem);
});

test("TP/oneM2M/CSE/REG/CRE/011 — From set to 'C' gets a CSE-assigned AE-ID starting with 'C'", async () => {
  // TS-0001:10.2.2.2 step 002 case iv -> step 004 case c.
  const res = await register(aeBody(), "C");

  assert.equal(res.rsc, "2001");
  assert.match(res.body["m2m:ae"].aei, /^C/);
  assert.ok(res.body["m2m:ae"].aei.length > 1, "'C' alone is a request, not an identifier");
});

test("TP/oneM2M/CSE/REG/CRE/022 — a registration with no AE-ID-Stem in From is accepted and assigned one", async () => {
  // TS-0001:10.2.2.2 step 002 case v: From is not sent and the CSE picks the starting character.
  const res = await request(srv.baseUrl, {
    method: "POST",
    to: CSE_BASE,
    ty: 2,
    body: aeBody(),
    originator: "",
  });

  assert.equal(res.rsc, "2001");
  assert.match(res.body["m2m:ae"].aei, /^[CS]./, "an AE-ID-Stem must start with 'C' or 'S'");
});

// CRE/012 is parameterized over the optional attributes accepted at registration
// (TS-0001 table 9.6.5-2). ontologyRef (OR) is included; nodeLink (NL) is not, for the reason
// given at RET/004.
const CRE_012 = [
  ["LBL", "lbl", ["cre-012"]],
  ["APN", "apn", "cre-012-app"],
  ["POA", "poa", ["http://127.0.0.1:1/notify"]],
  ["OR", "or", "http://example.invalid/ontology"],
];

for (const [suffix, attr, value] of CRE_012) {
  test(`TP/oneM2M/CSE/REG/CRE/012_AE/${suffix} — a registration carrying ${attr} is accepted and keeps it`, async () => {
    const res = await register(aeBody({ [attr]: value }));

    assert.equal(res.rsc, "2001", `${attr} was rejected: ${res.raw.slice(0, 200)}`);
    assert.deepEqual(res.body["m2m:ae"][attr], value);
  });
}

// CRE/017 is parameterized over the mandatory attributes: the TP table expands to _API and _RR.
for (const [suffix, attr] of [["API", "api"], ["RR", "rr"]]) {
  test(`TP/oneM2M/CSE/REG/CRE/017_${suffix} — a registration without ${attr} is rejected 4000`, async () => {
    const body = aeBody();
    delete body["m2m:ae"][attr];

    const res = await register(body);

    assert.equal(res.rsc, "4000");
  });
}

test("TP/oneM2M/CSE/REG/CRE/023 — re-registering an AE-ID-Stem that is already in use is rejected", async () => {
  // The TP expects 4105 CONFLICT; TS-0004:7.4.5.2.1 names ORIGINATOR_HAS_ALREADY_REGISTERED for
  // exactly this check. See the header for why this file follows TS-0004. If this ever has to
  // change to satisfy a certification run, change it here and record why — do not let the two
  // readings sit in the code without a note.
  const stem = `C${uniqueRn("dup").replace(/-/g, "")}`;
  await registerOk(aeBody(), stem);

  const again = await register(aeBody(), stem);

  assert.equal(
    again.rsc,
    "4117",
    `expected ORIGINATOR_HAS_ALREADY_REGISTERED per TS-0004:7.4.5.2.1 (the TP asks for 4105), got ${again.rsc}`
  );
});

test("TP/oneM2M/CSE/REG/CRE/021 — a CREATE of a <CSEBase> is rejected 4005", async () => {
  const res = await create(srv.baseUrl, CSE_BASE, 5, { "m2m:cb": { rn: uniqueRn("cb") } });

  assert.equal(res.rsc, "4005", "OPERATION_NOT_ALLOWED: the <CSEBase> is not created over Mca");
});

// ---------------------------------------------------------------------------
// 7.2.2.2.3 DELETE / 7.2.2.2.4 UPDATE
// ---------------------------------------------------------------------------

test("TP/oneM2M/CSE/REG/DEL/001 — a DELETE of the <CSEBase> is rejected 4005", async () => {
  const ae = await registerOk(aeBody());

  const res = await remove(srv.baseUrl, CSE_BASE, { originator: ae.aei });

  assert.equal(res.rsc, "4005");
  // A rejected request that nevertheless removed the tree would still "pass" the status check.
  const still = await retrieve(srv.baseUrl, CSE_BASE, { originator: ae.aei });
  assert.equal(still.rsc, "2000", "the <CSEBase> must still be there");
});

test("TP/oneM2M/CSE/REG/DEL/003 — an AE de-registration is answered 2002", async () => {
  const body = aeBody();
  const ae = await registerOk(body);
  const sid = `${CSE_BASE}/${body["m2m:ae"].rn}`;

  const res = await remove(srv.baseUrl, sid, { originator: ae.aei });

  assert.equal(res.rsc, "2002");
});

test("TP/oneM2M/CSE/REG/UPD/001 — an UPDATE of the <CSEBase> is rejected 4005", async () => {
  const ae = await registerOk(aeBody());

  const res = await update(srv.baseUrl, CSE_BASE, { "m2m:cb": { lbl: ["nope"] } }, { originator: ae.aei });

  assert.equal(res.rsc, "4005");
});
