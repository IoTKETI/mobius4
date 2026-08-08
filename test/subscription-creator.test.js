"use strict";
// The <subscription>'s creator attribute, and its trip into the notification.
//
// Two clauses, both "shall", both unimplemented until 2026-08-08:
//
//   TS-0004:7.4.8.2.1 (Recv-6.5, step 2) — "If the notificationURI is not the Originator, the
//   Hosting CSE shall set the Originator's ID as the <subscription> resource's creator attribute."
//
//   TS-0004:7.5.1.2.2 (step 2.1, repeated in .3/.4/.19/.20) — "if the <subscription> resource
//   instance has the creator attribute, the Originator shall set the creator element of the
//   notification data object to the value of the <subscription> resource's creator attribute."
//
// What mobius4 did: cr was written only when the request explicitly sent "cr": null, so the
// attribute appeared exactly when a client already knew to ask for it and was missing in the
// ordinary case the clause is about. And even when present it never reached the notification —
// m2m:sgn carried nev and sur only.
//
// Why it matters, from the report that found it: a gateway that both writes to the CSE and
// consumes notifications needs to drop the echo of its own writes. The subscription's creator is
// the standard way to tell whose subscription produced a notification. Note it is a different
// attribute from the *changed resource's* creator, which travels inside nev.rep and always worked.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { create, retrieve, createRoot, ADMIN } = require("./helpers/onem2m");
const { startServer } = require("./helpers/server");
const { startSink } = require("./helpers/noti-sink");

let srv, root, sink;

before(async () => {
  srv = await startServer();
  sink = await startSink();
  root = await createRoot(srv.baseUrl, "subcr");
});

after(async () => {
  if (root) await root.remove();
  if (sink) await sink.stop();
  if (srv) await srv.stop();
});

async function makeContainer(rn) {
  const res = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
  assert.equal(res.rsc, "2001");
  return `${root.sid}/${rn}`;
}

test("creator is set automatically when notificationURI is not the Originator", async () => {
  const cnt = await makeContainer("auto");
  const res = await create(srv.baseUrl, cnt, 23, {
    "m2m:sub": { rn: "s", nu: [sink.url], nct: 2, enc: { net: [3] } },
  });
  assert.equal(res.rsc, "2001");

  // Read it back rather than trusting the create response alone — the attribute has to be stored.
  const got = await retrieve(srv.baseUrl, `${cnt}/s`);
  assert.equal(got.body["m2m:sub"].cr, ADMIN, "the Originator's ID, per TS-0004:7.4.8.2.1");
});

test("an explicit null still means 'fill it in for me'", async () => {
  // The one form that already worked. Kept so the fix does not quietly drop it.
  const cnt = await makeContainer("explicit");
  const res = await create(srv.baseUrl, cnt, 23, {
    "m2m:sub": { rn: "s", nu: [sink.url], nct: 2, cr: null, enc: { net: [3] } },
  });
  assert.equal(res.rsc, "2001");

  const got = await retrieve(srv.baseUrl, `${cnt}/s`);
  assert.equal(got.body["m2m:sub"].cr, ADMIN);
});

test("creator is left unset when every notificationURI is the Originator itself", async () => {
  // The clause is conditional: "if the notificationURI is not the Originator". Reading it
  // literally keeps mobius4 from inventing an attribute the standard does not ask for.
  const cnt = await makeContainer("self");
  const res = await create(srv.baseUrl, cnt, 23, {
    "m2m:sub": { rn: "s", nu: [ADMIN], nct: 2, enc: { net: [3] } },
  });
  assert.equal(res.rsc, "2001");

  const got = await retrieve(srv.baseUrl, `${cnt}/s`);
  assert.equal(got.body["m2m:sub"].cr, undefined);
});

test("the notification carries the subscription's creator", async () => {
  const cnt = await makeContainer("noti");
  assert.equal(
    (await create(srv.baseUrl, cnt, 23, {
      "m2m:sub": { rn: "s", nu: [sink.url], nct: 2, enc: { net: [3] } },
    })).rsc,
    "2001"
  );

  assert.equal((await create(srv.baseUrl, cnt, 4, { "m2m:cin": { con: "v" } })).rsc, "2001");

  const item = await sink.waitFor((i) => sink.netOf(i) === 3);
  const sgn = item.body["m2m:sgn"];

  assert.equal(sgn.cr, ADMIN, "TS-0004:7.5.1.2.2 step 2.1");
  assert.ok(sgn.sur, "sur still present");
  assert.ok(sgn.nev, "nev still present");
});

test("a subscription cannot name someone else as its creator", async () => {
  // creator is "the AE-ID or CSE-ID of the entity which created the resource"
  // (TS-0001:9.6.1.3.2) — a statement about who acted, not a field to fill in freely. It is not
  // only an accuracy question: on a resource that defines accessControlPolicyIDs but has none
  // set, the creator is the identity with full control, so accepting a supplied value would let
  // a client hand that control to a third party.
  const cnt = await makeContainer("spoof");
  const res = await create(srv.baseUrl, cnt, 23, {
    "m2m:sub": { rn: "s", nu: [sink.url], nct: 2, cr: "SomeOtherEntity", enc: { net: [3] } },
  });

  assert.equal(res.rsc, "4000", `expected refusal, got ${res.rsc}`);
});

test("naming yourself as creator is accepted as the no-op it is", async () => {
  const cnt = await makeContainer("selfname");
  const res = await create(srv.baseUrl, cnt, 23, {
    "m2m:sub": { rn: "s", nu: [sink.url], nct: 2, cr: ADMIN, enc: { net: [3] } },
  });
  assert.equal(res.rsc, "2001");

  const got = await retrieve(srv.baseUrl, `${cnt}/s`);
  assert.equal(got.body["m2m:sub"].cr, ADMIN);
});
