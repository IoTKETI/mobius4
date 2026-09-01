"use strict";
// <flexContainer> specialization validation enforces multiplicity.
//
// TS-0004:7.4.37.2.1: the Hosting CSE "shall validate the received resource representation against
// the schema value present in the received resource containerDefinition attribute … If the
// received resource is not valid then the Hosting CSE shall return a response primitive with a
// Response Status Code indicating 'BAD_REQUEST' error." A specialization's XSD marks an attribute
// mandatory by leaving minOccurs at its default of 1, so a representation that omits one does not
// comply and must be refused.
//
// Before this, the validator only walked the attributes the *request* carried. Nothing ever looked
// at the declared set, so a <flexContainer> missing every mandatory attribute was created and
// answered 2001. Reported against v4.18.0 and v4.19.0 by a TR-0079 oneM2M-ROS 2 PoC.
//
// WHY THESE ARE VALIDATOR-LEVEL RATHER THAN OVER HTTP: the registry is read once from
// config/specializations.json when cse/specialization.js loads, and the only specialization this
// repository ships -- parkingBlock -- deliberately declares all six of its attributes
// minOccurs="0". There is no mandatory attribute to exercise end-to-end without either editing the
// shipped registry, which would change what an existing deployment accepts, or adding a registry
// path override for the benefit of tests. So the mandatory rule is asserted at the function that
// decides it, and the end-to-end case below asserts the other half: that the shipped registry
// still accepts what it accepted before.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, retrieve, update, createRoot, uniqueRn } = require("./helpers/onem2m");
const specialization = require("../cse/specialization");

// A specialization with three mandatory attributes and one optional one -- the shape the PoC
// reported against (org.onem2m.ros2.node declares ndNam, ndNsp and ndSta as mandatory).
const ENTRY = {
  typeName: "ros2Node",
  namespacePrefix: "ros2",
  attributes: {
    ndNam: { type: "string", required: true },
    ndNsp: { type: "string", required: true },
    ndSta: { type: "integer", required: true },
    note: { type: "string" },
  },
};

const COMPLETE = { ndNam: "talker", ndNsp: "/demo", ndSta: 1 };

test("TP/oneM2M/CSE/FLXC/CRE/001 — a representation missing mandatory attributes is not valid", () => {
  const none = specialization.validate_custom(ENTRY, {}, { creating: true });
  assert.equal(none.ok, false, "all three mandatory attributes are absent");
  for (const name of ["ndNam", "ndNsp", "ndSta"]) {
    assert.match(none.message, new RegExp(name), `the message should name ${name}: ${none.message}`);
  }

  // One missing is as invalid as three. This is the case a naive "is the object empty" check
  // would let through.
  const one = specialization.validate_custom(ENTRY, { ndNam: "talker", ndNsp: "/demo" }, { creating: true });
  assert.equal(one.ok, false, "ndSta is still missing");
  assert.match(one.message, /ndSta/);
});

test("a complete representation is valid, with or without the optional attribute", () => {
  assert.equal(specialization.validate_custom(ENTRY, COMPLETE, { creating: true }).ok, true);
  assert.equal(
    specialization.validate_custom(ENTRY, { ...COMPLETE, note: "hi" }, { creating: true }).ok, true);
});

test("UPDATE does not have to carry the mandatory attributes", () => {
  // An UPDATE carries only what is changing. Requiring the full mandatory set here would make
  // every partial update fail, which is a different bug from the one being fixed.
  assert.equal(specialization.validate_custom(ENTRY, { ndSta: 2 }).ok, true);
  assert.equal(specialization.validate_custom(ENTRY, { note: "changed" }).ok, true);
});

test("a mandatory attribute cannot be deleted by setting it to null", () => {
  // null is oneM2M's "delete this attribute" on UPDATE. Allowing it for a mandatory attribute
  // would leave the resource in a state the schema forbids and that no CREATE could produce --
  // the same hole as the missing-on-create case, reached from the other direction.
  const gone = specialization.validate_custom(ENTRY, { ndSta: null });
  assert.equal(gone.ok, false);
  assert.match(gone.message, /ndSta/);
  assert.match(gone.message, /mandatory/i);

  // An optional one may still be deleted, and its type is not checked when it is.
  assert.equal(specialization.validate_custom(ENTRY, { note: null }).ok, true);
});

test("an attribute named after an Object prototype member is undeclared, not declared", () => {
  // The declared set is a JSON.parse result, so its prototype chain still carries toString,
  // constructor and valueOf. Tested with `key in`, those read as declared, and the type lookup
  // then returned undefined -- which type_matches accepts through its default. A custom attribute
  // nobody declared was stored with no type check at all.
  for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
    const res = specialization.validate_custom(ENTRY, { ...COMPLETE, [name]: 12345 }, { creating: true });
    assert.equal(res.ok, false, `${name} should not count as declared`);
    assert.match(res.message, /is not declared/);
  }
});

test("a registry built before this check is not read as all-mandatory", () => {
  // Registries written by hand or built by v4.18.0 carry no `required` flag. Reading their absence
  // as "everything is mandatory" would refuse resources that were valid the moment before the
  // upgrade. Enforcement arrives when the registry is rebuilt from the manifest, not when the
  // binary is replaced.
  const legacy = { typeName: "parkingBlock", attributes: { type: { type: "string" }, name: { type: "string" } } };
  assert.equal(specialization.validate_custom(legacy, {}, { creating: true }).ok, true);
});

// ---------------------------------------------------------------- end to end

let srv, root;
const CND = "http://developers.iotocean.org/schema/parkingBlock.xsd";
const KEY = "sc:parkingBlock";

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "flxm");
});
after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
});

test("the shipped specialization still accepts a <flexContainer> with no custom attributes", async () => {
  // The other half of the change: parkingBlock declares all six attributes minOccurs="0", so
  // rebuilding its registry adds no `required` flag and nothing an existing deployment sends
  // becomes invalid. If this ever fails, the shipped registry has been tightened.
  const rn = uniqueRn("pb");
  const made = await create(srv.baseUrl, root.sid, 28, { [KEY]: { rn, cnd: CND } });
  assert.equal(made.rsc, "2001", `a bare parkingBlock must still be created: ${made.raw.slice(0, 200)}`);

  const got = await retrieve(srv.baseUrl, `${root.sid}/${rn}`);
  assert.equal(got.rsc, "2000");
  assert.equal(got.body[KEY].cnd, CND);
});

test("an undeclared custom attribute is still refused end to end", async () => {
  // Guard that the validator rewrite did not loosen the check that was already working -- the
  // control the bug report used to show the gate itself was alive.
  const bad = await create(srv.baseUrl, root.sid, 28, {
    [KEY]: { rn: uniqueRn("pb"), cnd: CND, notDeclaredAnywhere: 1 },
  });
  assert.equal(bad.rsc, "4000", `an undeclared attribute must be refused: ${bad.raw.slice(0, 200)}`);
});

test("an optional attribute can still be deleted with null on UPDATE", async () => {
  const rn = uniqueRn("pb");
  const made = await create(srv.baseUrl, root.sid, 28, { [KEY]: { rn, cnd: CND, name: "north lot" } });
  assert.equal(made.rsc, "2001", `setup failed: ${made.raw.slice(0, 200)}`);

  const cleared = await update(srv.baseUrl, `${root.sid}/${rn}`, { [KEY]: { name: null } });
  assert.equal(cleared.rsc, "2004", `clearing an optional attribute must still work: ${cleared.raw.slice(0, 200)}`);
});
