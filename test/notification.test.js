"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, update, remove, createRoot, uniqueRn, CSE_BASE } = require("./helpers/onem2m");
const { startSink, netOf } = require("./helpers/noti-sink");

let srv, root, sink;

before(async () => {
  srv = await startServer();
  sink = await startSink();
  root = await createRoot(srv.baseUrl, "noti");
});
after(async () => {
  if (root) await root.remove();
  if (sink) await sink.stop();
  if (srv) await srv.stop();
});

// Create a fresh <container> with its <subscription> every time — so notifications from
// different tests do not get mixed up.
async function cntWithSub(enc, extraCnt = {}) {
  const cnt = uniqueRn("c");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: cnt, ...extraCnt } });
  const sub = uniqueRn("s");
  const res = await create(srv.baseUrl, `${root.sid}/${cnt}`, 23, {
    "m2m:sub": { rn: sub, nu: [sink.url], enc, nct: 1 },
  });
  assert.equal(res.rsc, "2001", `failed to create the <subscription>: ${res.raw.slice(0, 200)}`);
  return { cntSid: `${root.sid}/${cnt}`, subSid: `${root.sid}/${cnt}/${sub}` };
}

test("net=3 — notifies on creation of a direct child", async () => {
  const { cntSid, subSid } = await cntWithSub({ net: [3] });
  await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: 1 } } });
  const got = await sink.waitFor((i) => netOf(i) === 3 && i.body["m2m:sgn"].sur === subSid);
  const sgn = got.body["m2m:sgn"];
  assert.equal(sgn.nev.net, 3);
  assert.equal(sgn.sur, subSid);
  assert.ok(sgn.nev.rep["m2m:cin"], `nev.rep should carry the created resource: ${JSON.stringify(sgn.nev.rep)}`);
});

test("net=1 — notifies on update of the subscribed-to resource", async () => {
  const { cntSid, subSid } = await cntWithSub({ net: [1] });
  await update(srv.baseUrl, cntSid, { "m2m:cnt": { lbl: ["changed"] } });
  const got = await sink.waitFor((i) => netOf(i) === 1 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 1);
});

test("a notification carries the request parameters a receiver validates", async () => {
  // TS-0018에 해당 TP 없음. A notification is a request primitive, and TS-0004:6.4.1 table
  // 6.4.1-1 gives Release Version Indicator multiplicity 1 -- mandatory, not optional. It was
  // missing from the HTTP notification path while both the MQTT path and the retargeting path
  // set it, and a third-party receiver that validates its request parameters rejected the
  // notification outright. Nothing here caught it because the sink was not recording headers.
  const { cntSid, subSid } = await cntWithSub({ net: [1] });
  const upd = await update(srv.baseUrl, cntSid, { "m2m:cnt": { lbl: ["hdrs"] } });
  assert.equal(upd.rsc, "2004", `the update must succeed: ${upd.raw.slice(0, 160)}`);

  const got = await sink.waitFor((i) => netOf(i) === 1 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.method, "POST");
  for (const h of ["x-m2m-origin", "x-m2m-ri", "x-m2m-rvi"]) {
    assert.ok(got.headers[h], `${h} is mandatory on a request primitive, got ${JSON.stringify(Object.keys(got.headers))}`);
  }
  assert.match(got.headers["x-m2m-rvi"], /^[0-9]/, `rvi should be a release version, got ${got.headers["x-m2m-rvi"]}`);
});

test("net=2 — notifies on deletion of the subscribed-to resource", async () => {
  const { cntSid, subSid } = await cntWithSub({ net: [2] });
  await remove(srv.baseUrl, cntSid);
  const got = await sink.waitFor((i) => netOf(i) === 2 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 2);
});

test("enc.chty filters child types for net=3", async () => {
  // Only chty=[4] (CIN) is allowed -> creating a CIN notifies, creating a <container> child
  // does not.
  const { cntSid, subSid } = await cntWithSub({ net: [3], chty: [4] });
  await create(srv.baseUrl, cntSid, 3, { "m2m:cnt": { rn: uniqueRn("nested") } });
  await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: 2 } } });

  const got = await sink.waitFor((i) => netOf(i) === 3 && i.body["m2m:sgn"].sur === subSid);
  assert.ok(got.body["m2m:sgn"].nev.rep["m2m:cin"], "what was notified should be the CIN");

  const mine = sink.received.filter((i) => i.body?.["m2m:sgn"]?.sur === subSid);
  assert.equal(mine.length, 1, `this <subscription> should produce exactly 1 notification (the <container> creation is filtered out). actual ${mine.length}`);
});

test("a <subscription> set to net=[3] only does not notify on CIN deletion (regression guard)", async () => {
  // When net=4 is implemented, <subscription>s that only ask for net=3 must not start
  // receiving deletion notifications.
  const { cntSid, subSid } = await cntWithSub({ net: [3] });
  const cin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: 3 } } });
  await sink.waitFor((i) => netOf(i) === 3 && i.body["m2m:sgn"].sur === subSid);

  // Assert first that the deletion actually succeeded — if the deletion fails silently, "no
  // deletion notification" becomes trivially true and the test goes green while verifying
  // nothing.
  const del = await remove(srv.baseUrl, `${cntSid}/${cin.body["m2m:cin"].rn}`);
  assert.equal(del.rsc, "2002", `the CIN deletion must succeed for this regression test to mean anything: ${del.raw.slice(0, 200)}`);

  const deleteNotis = await sink.expectNone(
    (i) => i.body?.["m2m:sgn"]?.sur === subSid && [2, 4].includes(netOf(i))
  );
  assert.deepEqual(deleteNotis.map(netOf), [], "there should be no deletion notification");
});

test("net=4 — notifies when a direct child is explicitly DELETEd", async () => {
  // Implemented: at the entry point of check_and_send_noti, notify_parent_of_child_deletion
  // separately looks up the <subscription>s under the deleted child's parent and fires net=4.
  const { cntSid, subSid } = await cntWithSub({ net: [4] });
  const cin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: 4 } } });
  await remove(srv.baseUrl, `${cntSid}/${cin.body["m2m:cin"].rn}`);
  const got = await sink.waitFor((i) => netOf(i) === 4 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 4);
});

test("net=4 — the notification carries the representation of the deleted child", async () => {
  // DEC-038: nev.rep is the full representation of the child as it was immediately before
  // deletion. Sending only the ID, or sending it empty, leaves the application unable to tell
  // *what* it lost, which defeats the purpose of this feature.
  const { cntSid, subSid } = await cntWithSub({ net: [4] });
  const cin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { payload: "keep-me" } } });
  const rn = cin.body["m2m:cin"].rn;
  await remove(srv.baseUrl, `${cntSid}/${rn}`);

  const got = await sink.waitFor((i) => netOf(i) === 4 && i.body["m2m:sgn"].sur === subSid);
  const rep = got.body["m2m:sgn"].nev.rep;
  assert.ok(rep["m2m:cin"], `the representation of the deleted CIN should be present: ${JSON.stringify(rep)}`);
  assert.equal(rep["m2m:cin"].rn, rn);
  assert.deepEqual(rep["m2m:cin"].con, { payload: "keep-me" });
});

test("net=4 — enc.chty filters child types", async () => {
  // TS-0004:7.5.1.2.2 Step 1.0 — when chty is present, it fires only when a child of that
  // type is deleted. Only chty=[3] (<container>) is allowed here, so deleting a CIN must not
  // notify.
  const { cntSid, subSid } = await cntWithSub({ net: [4], chty: [3] });
  const cin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: 1 } } });
  const del = await remove(srv.baseUrl, `${cntSid}/${cin.body["m2m:cin"].rn}`);
  assert.equal(del.rsc, "2002", "the deletion must succeed for this test to mean anything");

  const notis = await sink.expectNone((i) => i.body?.["m2m:sgn"]?.sur === subSid);
  assert.deepEqual(notis.map(netOf), [], "the type is not in chty, so there should be no notification");
});

test("net=4 — a grandparent <subscription> does not fire (direct parent only)", async () => {
  // DEC-038: the event is named 'Delete of *Direct* Child Resource'. Propagating up to
  // ancestors would make a single deletion produce as many notifications as the tree is deep.
  const gp = uniqueRn("gp");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: gp } });
  const gpSub = uniqueRn("gpsub");
  await create(srv.baseUrl, `${root.sid}/${gp}`, 23, {
    "m2m:sub": { rn: gpSub, nu: [sink.url], enc: { net: [4] }, nct: 1 },
  });
  const gpSubSid = `${root.sid}/${gp}/${gpSub}`;

  // Grandchild chain: grandparent -> child <container> -> CIN
  const mid = uniqueRn("mid");
  await create(srv.baseUrl, `${root.sid}/${gp}`, 3, { "m2m:cnt": { rn: mid } });
  const cin = await create(srv.baseUrl, `${root.sid}/${gp}/${mid}`, 4, { "m2m:cin": { con: { v: 1 } } });
  const del = await remove(srv.baseUrl, `${root.sid}/${gp}/${mid}/${cin.body["m2m:cin"].rn}`);
  assert.equal(del.rsc, "2002");

  const notis = await sink.expectNone((i) => i.body?.["m2m:sgn"]?.sur === gpSubSid);
  assert.deepEqual(notis.map(netOf), [], "the grandparent <subscription> must not fire");
});

test("cascading descendant deletion produces no notification (indirect deletion)", async () => {
  // DEC-039 / SQ-001: when a parent is deleted and its descendants go with it, net=4 does not
  // fire for those descendants. This pins down the current fact that delete_resources never
  // calls the notification function at all, so that if someone later wires notifications into
  // that path, it gets caught here.
  const outer = uniqueRn("outer");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: outer } });
  const inner = uniqueRn("inner");
  await create(srv.baseUrl, `${root.sid}/${outer}`, 3, { "m2m:cnt": { rn: inner } });

  // Attach a net=4 <subscription> to inner, which would fire when a CIN under inner is deleted
  const innerSub = uniqueRn("isub");
  await create(srv.baseUrl, `${root.sid}/${outer}/${inner}`, 23, {
    "m2m:sub": { rn: innerSub, nu: [sink.url], enc: { net: [4] }, nct: 1 },
  });
  const innerSubSid = `${root.sid}/${outer}/${inner}/${innerSub}`;
  await create(srv.baseUrl, `${root.sid}/${outer}/${inner}`, 4, { "m2m:cin": { con: { v: 1 } } });

  // Deleting outer makes inner and its CIN disappear by cascade
  const del = await remove(srv.baseUrl, `${root.sid}/${outer}`);
  assert.equal(del.rsc, "2002");

  const notis = await sink.expectNone((i) => i.body?.["m2m:sgn"]?.sur === innerSubSid);
  assert.deepEqual(notis.map(netOf), [], "cascading descendant deletion must not notify");
});

test("net=4 — deleting a child whose type matches enc.chty (<container>) does notify", async () => {
  // Regression guard (Finding 3): the "net=4 — enc.chty filters child types" test only ever
  // deletes a type that is *not* in chty (CIN), so a wrong implementation of "if chty is
  // present, never fire" would also pass it. Here we delete a child of a type that actually
  // is in chty (<container>, ty=3), pinning down the other side: "if it matches chty, it
  // fires".
  const { cntSid, subSid } = await cntWithSub({ net: [4], chty: [3] });
  const child = uniqueRn("child");
  await create(srv.baseUrl, cntSid, 3, { "m2m:cnt": { rn: child } });
  const del = await remove(srv.baseUrl, `${cntSid}/${child}`);
  assert.equal(del.rsc, "2002", "the deletion must succeed for this test to mean anything");

  const got = await sink.waitFor((i) => netOf(i) === 4 && i.body["m2m:sgn"].sur === subSid);
  const mine = sink.received.filter((i) => i.body?.["m2m:sgn"]?.sur === subSid);
  assert.equal(mine.length, 1, `this <subscription> should produce exactly 1 net=4 notification. actual ${mine.length}`);
  assert.ok(
    got.body["m2m:sgn"].nev.rep["m2m:cnt"],
    `the representation of the deleted <container> (m2m:cnt) should be present: ${JSON.stringify(got.body["m2m:sgn"].nev.rep)}`
  );
});

test("net=4 — eviction caused by exceeding mni notifies nobody", async () => {
  // Previously carried as { todo: true } on the assumption that the specification had not
  // settled whether eviction, being an indirect deletion, notifies. It has:
  //
  //   TS-0004:7.4.7.2.1 step 2 d) — "When removing the oldest <contentInstance> resources,
  //   the Hosting CSE shall not generate notifications even if there exists a <subscription>
  //   to the targeted <container> resource and this <subscription> is configured to generate
  //   a notification on Delete_of_Direct_Child_Resource."
  //
  // So silence is not a gap awaiting a decision; it is what the specification requires, and
  // the assertion is inverted accordingly. cse/noti.js implements it through the
  // int_cr_req !== true condition — the guard this test now protects.
  //
  // The other half of SQ-001 remains open: whether a cascade delete (removing an ancestor)
  // fires net=4 on the descendants' subscriptions is not covered by this clause.
  const { cntSid, subSid } = await cntWithSub({ net: [4] }, { mni: 3 });
  for (let i = 1; i <= 4; i++) {
    const r = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { seq: i } } });
    assert.equal(r.rsc, "2001");
  }
  // The 4th create pushed cni past mni, so exactly one <contentInstance> was evicted here.
  const notis = await sink.expectNone((i) => netOf(i) === 4 && i.body?.["m2m:sgn"]?.sur === subSid);
  assert.deepEqual(notis.map(netOf), [], "eviction must not notify (step 2 d)");
});

test("net=4 — a client-issued DELETE of a <contentInstance> still notifies", async () => {
  // The mirror of the test above, and the reason its guard cannot simply be "never notify on
  // a <cin> deletion": an ordinary DELETE of the same resource type must still fire. What
  // distinguishes them is that eviction is internal (int_cr_req), not the resource type.
  const { cntSid, subSid } = await cntWithSub({ net: [4] }, { mni: 100 });
  const res = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: "delete-me" } } });
  assert.equal(res.rsc, "2001");

  await remove(srv.baseUrl, `${cntSid}/${res.body["m2m:cin"].rn}`);
  const got = await sink.waitFor((i) => netOf(i) === 4 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 4);
});

// --- notificationURI as a oneM2M resource-ID -------------------------------------------------
//
// TS-0001:9.6.8 gives notificationURI two forms: "a oneM2M compliant Resource-ID as defined in
// clause 7.2 ... of an <AE> or <CSEBase> resource", or a protocol-binding URL. Everything above
// this line uses the URL form, and so did every other notification test in this repository, so
// the resource-ID branch of cse/noti.js -- resolve the ID, read the <AE>'s poa, send there -- had
// no coverage at all despite being the form the standard leads with.
//
// This matters beyond tidiness: TS-0004:7.4.8.2.1 Recv-6.4 makes subscription verification apply
// to exactly the targets "formatted as oneM2M-compliant resource-IDs", and the same clause says a
// response is expected "only if" the target is in that format. Work that follows this line is
// gated on the form these tests cover.
//
// TS-0018에 해당 TP 없음 -- the TPs for <subscription> creation do not distinguish the two forms
// of notificationURI.

// An <AE> whose poa points back at the local sink, so a notification addressed to the AE by
// resource ID arrives at the same place a URL nu would.
async function aeAtSink() {
  const rn = uniqueRn("ae");
  // Registered with no From so the CSE assigns a fresh AE-ID; the shared admin originator would
  // derive the same one twice and the second registration would be refused 4117.
  const res = await create(srv.baseUrl, CSE_BASE, 2, {
    "m2m:ae": { rn, api: "Nnoti.resid", rr: true, poa: [sink.url] },
  }, { originator: "" });
  assert.equal(res.rsc, "2001", `failed to create the <AE>: ${res.raw.slice(0, 200)}`);
  return { sid: `${CSE_BASE}/${rn}`, ri: res.body["m2m:ae"].ri };
}

async function cntSubbedTo(nu) {
  const cnt = uniqueRn("c");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: cnt } });
  const sub = uniqueRn("s");
  const res = await create(srv.baseUrl, `${root.sid}/${cnt}`, 23, {
    "m2m:sub": { rn: sub, nu: [nu], enc: { net: [3] }, nct: 1 },
  });
  assert.equal(res.rsc, "2001", `failed to create the <subscription>: ${res.raw.slice(0, 200)}`);
  return { cntSid: `${root.sid}/${cnt}`, subSid: `${root.sid}/${cnt}/${sub}` };
}

test("nu as a structured resource-ID delivers to the <AE>'s pointOfAccess", async () => {
  const ae = await aeAtSink();
  const { cntSid, subSid } = await cntSubbedTo(ae.sid);
  const marker = `structured-${Date.now()}`;
  await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: marker } });

  const got = await sink.waitFor((i) => i.body["m2m:sgn"]?.sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.rep["m2m:cin"].con, marker,
    "the resource-ID target receives the same notification a URL target would");
});

test("nu as an unstructured resource-ID delivers to the <AE>'s pointOfAccess", async () => {
  // The two spellings take different branches in prefetch_ae_poa -- a structured ID is resolved
  // through the lookup table first, an unstructured one is used as the ri directly -- so one
  // passing does not imply the other does.
  const ae = await aeAtSink();
  const { cntSid, subSid } = await cntSubbedTo(ae.ri);
  const marker = `unstructured-${Date.now()}`;
  await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: marker } });

  const got = await sink.waitFor((i) => i.body["m2m:sgn"]?.sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.rep["m2m:cin"].con, marker);
});

test("a resource-ID nu naming an <AE> with no pointOfAccess drops the notification quietly", async () => {
  // There is nowhere to send it. What is being pinned is that the event does not take the CSE
  // down and does not stall the request that triggered it: a create still answers 2001, and a
  // later notification on an unrelated subscription still arrives. Without the second half this
  // test would pass even if the notification path threw and was swallowed.
  const rn = uniqueRn("ae");
  const made = await create(srv.baseUrl, CSE_BASE, 2,
    { "m2m:ae": { rn, api: "Nnoti.nopoa", rr: false } }, { originator: "" });
  assert.equal(made.rsc, "2001", `failed to create the <AE>: ${made.raw.slice(0, 200)}`);

  const { cntSid } = await cntSubbedTo(`${CSE_BASE}/${rn}`);
  const dead = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: "goes-nowhere" } });
  assert.equal(dead.rsc, "2001", "the create must still succeed when the target is unreachable");

  const live = await cntSubbedTo(sink.url);
  const marker = `after-dead-target-${Date.now()}`;
  await create(srv.baseUrl, live.cntSid, 4, { "m2m:cin": { con: marker } });
  const got = await sink.waitFor((i) => i.body["m2m:sgn"]?.sur === live.subSid);
  assert.equal(got.body["m2m:sgn"].nev.rep["m2m:cin"].con, marker,
    "notifications must keep flowing after a target that could not be resolved");
});
