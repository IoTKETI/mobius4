"use strict";
// The "attribute" (atr) condition of eventNotificationCriteria.
//
// TS-0001:9.6.8 table 9.6.8-3 defines it as the subset of the subscribed-to resource's attributes
// whose update generates a notification: "If ANY attribute specified on this list is updated, then
// a notification shall be generated. If an attribute that is not specified in this list is
// updated, then a notification shall not be generated."
//
// The test purposes come from TS-0018 and are named on each test. The two notification cases are
// the pair TS-0018 already draws -- one that must fire and one that must not -- because either one
// alone passes against a broken implementation: a CSE that ignores atr entirely passes UPD/009,
// and a CSE that never notifies passes UPD/006.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, update, retrieve, uniqueRn, createRoot } = require("./helpers/onem2m");
const { startSink, netOf } = require("./helpers/noti-sink");

let srv, root, sink;

before(async () => {
  srv = await startServer();
  sink = await startSink();
  root = await createRoot(srv.baseUrl, "atr");
});
after(async () => {
  if (root) await root.remove();
  if (sink) await sink.stop();
  if (srv) await srv.stop();
});

// A fresh <container> with its own <subscription> per test, so notifications raised by one test
// cannot be mistaken for another's.
async function cntWithSub(enc) {
  const cnt = uniqueRn("c");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: cnt, lbl: ["before"], mni: 5 } });
  const sub = uniqueRn("s");
  const res = await create(srv.baseUrl, `${root.sid}/${cnt}`, 23, {
    "m2m:sub": { rn: sub, nu: [sink.url], enc, nct: 1 },
  });
  assert.equal(res.rsc, "2001", `failed to create the <subscription>: ${res.raw.slice(0, 200)}`);
  return { cntSid: `${root.sid}/${cnt}`, subSid: `${root.sid}/${cnt}/${sub}`, subRes: res };
}

test("TP/oneM2M/CSE/SUB/CRE/006_ATR — accepts a <subscription> whose eventNotificationCriteria carries the attribute condition", async () => {
  const { subSid, subRes } = await cntWithSub({ net: [1], atr: ["lbl"] });

  // The TP checks acceptance, but acceptance alone would also be satisfied by a CSE that parses
  // atr and drops it. Read the resource back: the condition has to have been stored, or the
  // filtering the subscriber asked for silently is not in force.
  const got = await retrieve(srv.baseUrl, subSid);
  assert.equal(got.rsc, "2000", `retrieving the <subscription> failed: ${got.raw.slice(0, 200)}`);
  assert.deepEqual(got.body["m2m:sub"].enc.atr, ["lbl"],
    `enc.atr should survive the round trip, got ${JSON.stringify(got.body["m2m:sub"].enc)}`);
  assert.equal(subRes.body["m2m:sub"].enc.atr.length, 1);
});

test("TP/oneM2M/CSE/SUB/UPD/009 — notifies when an attribute named in the condition is updated", async () => {
  const { cntSid, subSid } = await cntWithSub({ net: [1], atr: ["lbl"] });

  const upd = await update(srv.baseUrl, cntSid, { "m2m:cnt": { lbl: ["after"] } });
  assert.equal(upd.rsc, "2004", `the update must succeed: ${upd.raw.slice(0, 200)}`);

  const got = await sink.waitFor((i) => netOf(i) === 1 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 1);
});

test("TP/oneM2M/CSE/SUB/UPD/006 — does not notify when the updated attribute is outside the condition", async () => {
  const { cntSid, subSid } = await cntWithSub({ net: [1], atr: ["lbl"] });

  // Assert the update actually happened first. If it failed, "no notification" would be trivially
  // true and this test would go green while verifying nothing.
  const upd = await update(srv.baseUrl, cntSid, { "m2m:cnt": { mni: 7 } });
  assert.equal(upd.rsc, "2004", `the update must succeed for this test to mean anything: ${upd.raw.slice(0, 200)}`);
  const after = await retrieve(srv.baseUrl, cntSid);
  assert.equal(after.body["m2m:cnt"].mni, 7, "mni should really have changed");

  await sink.expectNone((i) => i.body?.["m2m:sgn"]?.sur === subSid);
});

test("an update touching one named and one unnamed attribute notifies — ANY member matches", async () => {
  // TS-0018 has no TP for the mixed case. Derived from TS-0001:9.6.8 table 9.6.8-3: "If ANY
  // attribute specified on this list is updated, then a notification shall be generated."
  const { cntSid, subSid } = await cntWithSub({ net: [1], atr: ["lbl"] });

  const upd = await update(srv.baseUrl, cntSid, { "m2m:cnt": { lbl: ["mixed"], mni: 9 } });
  assert.equal(upd.rsc, "2004", `the update must succeed: ${upd.raw.slice(0, 200)}`);

  const got = await sink.waitFor((i) => netOf(i) === 1 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 1);
});

test("a <subscription> with no attribute condition still notifies on any attribute update (regression guard)", async () => {
  // The default when the list is absent is the full attribute set. Filtering must not leak into
  // subscriptions that never asked for it.
  const { cntSid, subSid } = await cntWithSub({ net: [1] });

  const upd = await update(srv.baseUrl, cntSid, { "m2m:cnt": { mni: 3 } });
  assert.equal(upd.rsc, "2004", `the update must succeed: ${upd.raw.slice(0, 200)}`);

  const got = await sink.waitFor((i) => netOf(i) === 1 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 1);
});

test("an empty attribute condition is refused", async () => {
  // TS-0018 has no TP for this. m2m:attributeList is an xs:list of xs:NCName carrying
  // xs:minLength 1 (CDT-commonTypes.xsd:383), so [] is not a valid value. Refusing it matters
  // because the alternative readings disagree: "no condition" (notify on everything) and "nothing
  // matches" (notify on nothing) are opposite behaviours to hang on an invalid value.
  const cnt = uniqueRn("c");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: cnt } });
  const res = await create(srv.baseUrl, `${root.sid}/${cnt}`, 23, {
    "m2m:sub": { rn: uniqueRn("s"), nu: [sink.url], enc: { net: [1], atr: [] } },
  });
  assert.equal(res.rsc, "4000", `an empty atr should be refused, got ${res.rsc}: ${res.raw.slice(0, 200)}`);
});

test("the attribute condition can be changed by UPDATE", async () => {
  // enc is RW (TS-0001 table 9.6.8-2), so a subscriber that set atr at creation must be able to
  // change it. Before this feature the update schema had no atr at all and the request was 4000.
  const { cntSid, subSid } = await cntWithSub({ net: [1], atr: ["lbl"] });

  const chg = await update(srv.baseUrl, subSid, { "m2m:sub": { enc: { net: [1], atr: ["mni"] } } });
  assert.equal(chg.rsc, "2004", `updating enc.atr should be accepted: ${chg.raw.slice(0, 200)}`);

  // The new condition, not the old one, is what now decides.
  const upd = await update(srv.baseUrl, cntSid, { "m2m:cnt": { mni: 4 } });
  assert.equal(upd.rsc, "2004", `the update must succeed: ${upd.raw.slice(0, 200)}`);

  const got = await sink.waitFor((i) => netOf(i) === 1 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 1);
});
