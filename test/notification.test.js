"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, update, remove, createRoot, uniqueRn } = require("./helpers/onem2m");
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

test("net=4 — also notifies on eviction caused by exceeding mni", { todo: true }, async () => {
  // This is not unimplemented; it is pending a spec clarification (SQ-001): whether eviction
  // (int_cr_req:true) should, as an indirect deletion, produce a notification is not settled
  // in the oneM2M specification (DEC-039). check_and_send_noti deliberately excludes eviction
  // via the int_cr_req !== true condition, so zero notifications is correct for now — once
  // this is clarified, the condition gets adjusted and this test gets inverted.
  const { cntSid, subSid } = await cntWithSub({ net: [4] }, { mni: 3 });
  for (let i = 1; i <= 4; i++) {
    const r = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { seq: i } } });
    assert.equal(r.rsc, "2001");
  }
  const got = await sink.waitFor((i) => netOf(i) === 4 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 4);
});
