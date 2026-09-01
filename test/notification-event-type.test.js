"use strict";
// Which notificationEventType (net) values a <subscription> may carry, and what happens to the
// ones this CSE does not act on.
//
// Three outcomes are possible for a condition a CSE does not honour, and they are not equally
// good: refuse it (the client learns), accept and ignore it (the client believes a filter is in
// force that is not), or accept it and then do nothing at all (no error, no notification). net was
// in the third state -- the schema checked only that the values were integers, and cse/noti.js
// branches on 1, 2, 3 and 4, so a subscription asking for 8 was created, answered 2001, and never
// fired.
//
// TS-0018 has no test purpose for "the IUT refuses a notificationEventType it does not implement".
// The ones that exist -- TP/oneM2M/CSE/SUB/CRE/009 and its neighbours -- check rejection of net=6
// and net=7 in *combination* with other values, which is a different rule (TS-0001:9.6.8 table
// 9.6.8-3 forbids combining 7, and scopes 6 to <AE> parents). These tests are derived instead from
// the enumeration in CDT-enumerationTypes.xsd:986 and from what cse/noti.js actually branches on,
// and are named plainly so nobody reads an invented TP identifier into them.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, update, uniqueRn, createRoot } = require("./helpers/onem2m");
const { DEFINED_NET, IMPLEMENTED_NET } = require("../cse/notification-event-types");

let srv, root, cntSid;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "net");
  const cnt = uniqueRn("c");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: cnt } });
  cntSid = `${root.sid}/${cnt}`;
});
after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
});

const NU = ["http://127.0.0.1:1/never"];

function subWith(enc) {
  return create(srv.baseUrl, cntSid, 23, {
    "m2m:sub": { rn: uniqueRn("s"), nu: NU, enc },
  });
}

test("a net value outside the enumeration is refused as BAD_REQUEST", async () => {
  // CDT-enumerationTypes.xsd:986 restricts m2m:notificationEventType to 1..8. 0, 9 and 99 are not
  // oneM2M values at all, so the representation is invalid.
  for (const bad of [0, 9, 99, -1]) {
    const res = await subWith({ net: [bad] });
    assert.equal(res.rsc, "4000", `net=[${bad}] should be 4000, got ${res.rsc}: ${res.raw.slice(0, 160)}`);
  }
});

test("a net value oneM2M defines but this CSE does not act on is refused as NOT_IMPLEMENTED", async () => {
  // 5..8 are real oneM2M values. Answering 4000 would tell the subscriber their request was
  // malformed, which is false; answering 2001 and then never notifying is what this replaces.
  for (const unimpl of [5, 6, 7, 8]) {
    const res = await subWith({ net: [unimpl] });
    assert.equal(res.rsc, "5001", `net=[${unimpl}] should be 5001, got ${res.rsc}: ${res.raw.slice(0, 160)}`);
    assert.match(res.body["m2m:dbg"] || "", /notificationEventType/,
      `the debug text should name the attribute: ${res.raw.slice(0, 160)}`);
  }
});

test("an unimplemented net value is refused even when mixed with an implemented one", async () => {
  // The whole list has to be checked, not just its first member: net is 0..5 and a subscriber may
  // ask for several. Accepting [1, 8] would silently drop the 8 half of the request.
  const res = await subWith({ net: [1, 8] });
  assert.equal(res.rsc, "5001", `net=[1,8] should be 5001, got ${res.rsc}: ${res.raw.slice(0, 160)}`);
});

test("the implemented net values are still accepted", async () => {
  // Regression guard: the range check must not narrow what already worked.
  for (const ok of [1, 2, 3, 4]) {
    const res = await subWith({ net: [ok] });
    assert.equal(res.rsc, "2001", `net=[${ok}] should still be created, got ${res.rsc}: ${res.raw.slice(0, 160)}`);
  }
  const several = await subWith({ net: [1, 2, 3, 4] });
  assert.equal(several.rsc, "2001", `net=[1,2,3,4] should be created: ${several.raw.slice(0, 160)}`);
});

test("UPDATE is held to the same net rules as CREATE", async () => {
  // enc is RW. A rule enforced only on create is a rule a subscriber can step around by creating a
  // valid subscription and then updating it.
  const made = await subWith({ net: [1] });
  assert.equal(made.rsc, "2001", `setup failed: ${made.raw.slice(0, 160)}`);
  const subSid = `${cntSid}/${made.body["m2m:sub"].rn}`;

  const outside = await update(srv.baseUrl, subSid, { "m2m:sub": { enc: { net: [99] } } });
  assert.equal(outside.rsc, "4000", `net=[99] on update should be 4000, got ${outside.rsc}`);

  const unimpl = await update(srv.baseUrl, subSid, { "m2m:sub": { enc: { net: [7] } } });
  assert.equal(unimpl.rsc, "5001", `net=[7] on update should be 5001, got ${unimpl.rsc}`);

  const fine = await update(srv.baseUrl, subSid, { "m2m:sub": { enc: { net: [2] } } });
  assert.equal(fine.rsc, "2004", `net=[2] on update should be accepted: ${fine.raw.slice(0, 160)}`);
});

test("om (operationMonitor) is refused rather than accepted and ignored", async () => {
  // om was accepted as Joi.any() and read by nothing, so a subscriber who asked to be notified
  // only about particular operations or Originators was notified about everything instead. There
  // is no plan to implement it; refusing says so rather than pretending.
  const res = await subWith({ net: [1], om: [{ ops: 4, org: "CAE-x" }] });
  assert.equal(res.rsc, "4000", `om should be refused, got ${res.rsc}: ${res.raw.slice(0, 160)}`);

  const onUpdate = await create(srv.baseUrl, cntSid, 23, { "m2m:sub": { rn: uniqueRn("s"), nu: NU, enc: { net: [1] } } });
  assert.equal(onUpdate.rsc, "2001", `setup failed: ${onUpdate.raw.slice(0, 160)}`);
  const upd = await update(srv.baseUrl, `${cntSid}/${onUpdate.body["m2m:sub"].rn}`,
    { "m2m:sub": { enc: { net: [1], om: [{ ops: 4 }] } } });
  assert.equal(upd.rsc, "4000", `om should be refused on update too, got ${upd.rsc}`);
});

test("the implemented-net list matches what the notification path branches on", async () => {
  // cse/noti.js decides in code; cse/notification-event-types.js states it as data, and sub.js
  // rejects from that data. If someone adds a branch there and forgets this list, a working
  // capability starts answering 5001 -- so the list is asserted directly, the way
  // test/unimplemented-and-clearing.test.js asserts the parent-governed types.
  assert.deepEqual([...IMPLEMENTED_NET].sort(), [1, 2, 3, 4]);
  assert.deepEqual([...DEFINED_NET].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);

  const noti = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "cse", "noti.js"), "utf8");
  for (const v of IMPLEMENTED_NET) {
    assert.match(noti, new RegExp(`net\\.includes\\(${v}\\)`),
      `cse/noti.js should branch on net=${v}, since the list claims it is implemented`);
  }
});
