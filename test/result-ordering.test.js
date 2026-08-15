"use strict";
// Child resources come back newest first, and the sequence is total.
//
// TS-0018 has no test purpose for this. The DIS group (TP/oneM2M/CSE/DIS/001..) covers which
// resources a discovery matches, never the order they arrive in, and no other group does either
// — checked by searching all five source files of TS-0018 for ordering language. That is
// consistent with the core spec: TS-0001:8.1.2 gives filterCriteria a limit, an offset and
// createdBefore/createdAfter, but no sort condition, and nothing in TS-0001 or TS-0004 states
// the order of a result. Order is therefore a Hosting CSE decision, and these tests pin the
// decision this CSE made rather than a conformance requirement.
//
// What *is* a conformance matter is the second half: offset indexes into the result sequence
// (TS-0001:8.1.2), which is only meaningful if the sequence is the same from one request to the
// next. Before this change the per-type query was a LIMIT with no ORDER BY, so neither the order
// nor the membership of a page was fixed.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, retrieve, update, discover, urils, createRoot, uniqueRn } = require("./helpers/onem2m");

let srv, root, cntRn, cntSid;
// Instance resourceNames in the order they were created. They are auto-generated and random
// (get_a_new_rn in cse/hostingCSE.js), so nothing about the name tells the CSE their age —
// which is the point: only stateTag can separate them.
const created = [];
const CIN_COUNT = 5;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "ord");
  cntRn = uniqueRn("ord-cnt");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: cntRn } });
  cntSid = `${root.sid}/${cntRn}`;
  for (let i = 0; i < CIN_COUNT; i++) {
    const res = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { seq: i } } });
    created.push(res.body["m2m:cin"].rn);
  }
});

after(async () => { if (root) await root.remove(); if (srv) await srv.stop(); });

const newestFirst = () => [...created].reverse().map(rn => `${cntSid}/${rn}`);

test("discovery returns <contentInstance>s newest first", async () => {
  // All five are created inside the same second, so creationTime cannot tell them apart
  // (TS-0004:6.3.3 gives timestamps a one-second resolution). stateTag is what does, and it is
  // the same key <latest> already uses.
  const list = urils(await discover(srv.baseUrl, cntSid, { ty: "4" }));
  assert.deepEqual(list, newestFirst());
});

test("lim returns the newest N, not the oldest N", async () => {
  const list = urils(await discover(srv.baseUrl, cntSid, { ty: "4", lim: "2" }));
  assert.deepEqual(list, newestFirst().slice(0, 2));
});

test("<latest> agrees with the first entry of the discovery result", async () => {
  // The two answer the same question by different routes — find_edge_cin orders by st DESC,
  // discovery now orders by the same key. If they ever disagree, one of them is lying about
  // which instance is the newest.
  const la = await retrieve(srv.baseUrl, `${cntSid}/la`);
  assert.equal(la.rsc, "2000");
  assert.equal(`${cntSid}/${la.body["m2m:cin"].rn}`, newestFirst()[0]);
});

test("paging with ofst covers every instance exactly once", async () => {
  // The regression this pins is not the order but the membership: LIMIT without ORDER BY does
  // not fix which rows come back, so two pages could omit a resource or return one twice.
  // ofst is 1-based (TS-0001:8.1.2, "The offset shall start at 1"; DEC-096).
  const seen = [];
  for (let ofst = 1; ofst <= CIN_COUNT; ofst += 2) {
    const page = urils(await discover(srv.baseUrl, cntSid, { ty: "4", lim: "2", ofst: String(ofst) }));
    seen.push(...page);
  }
  assert.deepEqual(seen, newestFirst());
});

test("rcn=4 nests the instances newest first too", async () => {
  const res = await retrieve(srv.baseUrl, `${cntSid}?rcn=4`);
  assert.equal(res.rsc, "2000");
  const instances = res.body["m2m:cnt"]["m2m:cin"];
  assert.ok(Array.isArray(instances), `expected an m2m:cin array, got ${JSON.stringify(res.body)}`);
  assert.deepEqual(instances.map(c => c.rn), [...created].reverse());
});

test("siblings created in the same second fall in name order, not a random one", async () => {
  // Outside <contentInstance> nothing stored says which of two same-second resources is younger:
  // creationTime is the finest age this CSE records (TS-0004:6.3.3) and no table carries an
  // insertion sequence. The tiebreak therefore cannot be about age -- but it still has to be
  // total, because ofst indexes into this order (TS-0001:8.1.2).
  //
  // So it is sid, ascending: arbitrary with respect to age, but predictable, which resourceID
  // would not be (generate_ri is random). Created here in the reverse of name order so that a
  // pass cannot be explained by insertion order.
  const parent = uniqueRn("tiebreak");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: parent } });
  const parentSid = `${root.sid}/${parent}`;
  for (const rn of ["c-third", "b-second", "a-first"]) {
    await create(srv.baseUrl, parentSid, 3, { "m2m:cnt": { rn } });
  }

  const list = urils(await discover(srv.baseUrl, parentSid, { ty: "3" }));
  assert.deepEqual(list, ["a-first", "b-second", "c-third"].map(rn => `${parentSid}/${rn}`));
});

test("a busy old <container> does not outrank a newly created one", async () => {
  // stateTag means something different here: for <container> it counts the resource's own
  // updates (update_a_cnt does db_res.st++), not its age, so ordering containers by st would put
  // the oldest busiest one first. This is why st is applied to <contentInstance> alone.
  const busyRn = uniqueRn("busy");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: busyRn } });
  for (let i = 0; i < 3; i++) {
    await update(srv.baseUrl, `${root.sid}/${busyRn}`, { "m2m:cnt": { lbl: [`bump${i}`] } });
  }

  // creationTime has a one-second resolution, so the two containers need to land in different
  // seconds for this assertion to be about age at all.
  await new Promise(r => setTimeout(r, 1100));
  const freshRn = uniqueRn("fresh");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: freshRn } });

  const list = urils(await discover(srv.baseUrl, root.sid, { ty: "3" }));
  const busyAt = list.indexOf(`${root.sid}/${busyRn}`);
  const freshAt = list.indexOf(`${root.sid}/${freshRn}`);
  assert.ok(busyAt !== -1 && freshAt !== -1, `both containers should be listed: ${JSON.stringify(list)}`);
  assert.ok(freshAt < busyAt,
    `the newer container should come first, but the busy one did: ${JSON.stringify(list)}`);
});
