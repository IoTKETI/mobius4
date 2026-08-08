"use strict";
// <group> memberType validation, and the silent success it used to report.
//
// TS-0001:9.6.13 defines consistencyStrategy and its default in the same sentence:
//
//   "This attribute determines how to deal with the <group> resource if the memberType validation
//    fails. […] delete the inconsistent member if the attribute is ABANDON_MEMBER; delete the
//    group if the attribute is ABANDON_GROUP; set the memberType to 'mixed' if the attribute is
//    SET_MIXED. If it is not given by the Originator at the creation procedure, default is
//    ABANDON_MEMBER."
//
// mobius4 read csy straight off the request with no default, so a group whose members did not all
// match memberType fell past every branch to a bare `return false` that set no response status.
// create_a_grp returned with nothing set and reqPrim's CREATE branch filled in 2001 — the
// Originator was told the group existed and it did not.
//
// Measured 2026-08-08, before the fix: mt=3 with one <container> and one <AE> answered 2001 with
// an empty body; a later GET answered 4004 and the grp table had no row. It was first seen with a
// member on another CSE, but the remote member was only the trigger — a mixed local list does it
// too, which is what these tests use.
//
// Deliberately not run as the administrator: this is a plain originator's request, and the
// validation must behave the same for anyone. (Fan-out tests may use the admin identity to get
// past access control; this procedure has no reason to.)

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { create, retrieve, remove, createRoot, uniqueRn, CSE_BASE } = require("./helpers/onem2m");
const { startServer } = require("./helpers/server");

let srv, root, cnt, ae_id;
// <group> is not a valid child of <container> (4108), so the groups live under the <CSEBase> and
// are removed one by one — unlike the container member, which the test root takes with it.
const made = [];
const MEMBER_TYPE_CONTAINER = 3;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "grpmv");

  cnt = `${root.sid}/c`;
  assert.equal((await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: "c" } })).rsc, "2001");

  // An <AE> to be the member of the wrong type. Registered with no From so the CSE assigns the
  // AE-ID; reusing one identity would collide on a rerun (the test database persists).
  const ae = await create(srv.baseUrl, CSE_BASE, 2,
    { "m2m:ae": { rn: uniqueRn("ae"), api: "Nx.test", rr: true } }, { originator: "" });
  assert.equal(ae.rsc, "2001");
  ae_id = `${CSE_BASE}/${ae.body["m2m:ae"].rn}`;
});

after(async () => {
  for (const sid of made) await remove(srv.baseUrl, sid);
  if (root) await root.remove();
  if (srv) await srv.stop();
});

async function mkGroup(body) {
  const rn = uniqueRn(body.rn);
  made.push(`${CSE_BASE}/${rn}`);
  return await create(srv.baseUrl, CSE_BASE, 9, { "m2m:grp": { ...body, rn } });
}

// The address a group ended up at, for reading it back.
const lastMade = () => made[made.length - 1];

test("a group whose members all match memberType is created", async () => {
  const res = await mkGroup({ rn: "ok", mt: MEMBER_TYPE_CONTAINER, mnm: 10, mid: [cnt] });

  assert.equal(res.rsc, "2001");
  assert.deepEqual(res.body["m2m:grp"].mid, [cnt]);
  assert.equal(res.body["m2m:grp"].cnm, 1);
});

test("without consistencyStrategy, an inconsistent member is dropped and the group is created", async () => {
  // The default of TS-0001:9.6.13. Before the fix this answered 2001 and created nothing.
  const res = await mkGroup({ rn: "default", mt: MEMBER_TYPE_CONTAINER, mnm: 10, mid: [cnt, ae_id] });

  assert.equal(res.rsc, "2001");
  assert.deepEqual(res.body["m2m:grp"].mid, [cnt], "the <AE> was abandoned, not the group");
  assert.equal(res.body["m2m:grp"].cnm, 1, "cnm counts what is left");
  assert.equal(res.body["m2m:grp"].mt, MEMBER_TYPE_CONTAINER, "memberType is unchanged");

  // The point of the whole test: a 2001 has to mean the resource is there.
  const got = await retrieve(srv.baseUrl, lastMade());
  assert.equal(got.rsc, "2000", "a group reported as created must exist");
});

test("ABANDON_GROUP refuses the request instead of reporting success", async () => {
  const res = await mkGroup({ rn: "abandon", mt: MEMBER_TYPE_CONTAINER, mnm: 10, csy: 2, mid: [cnt, ae_id] });

  assert.equal(res.rsc, "4110", "GROUP_MEMBER_TYPE_INCONSISTENT");

  const got = await retrieve(srv.baseUrl, lastMade());
  assert.equal(got.rsc, "4004", "and nothing is left behind");
});

test("SET_MIXED keeps every member and turns memberType into mixed", async () => {
  const res = await mkGroup({ rn: "mixed", mt: MEMBER_TYPE_CONTAINER, mnm: 10, csy: 3, mid: [cnt, ae_id] });

  assert.equal(res.rsc, "2001");
  assert.equal(res.body["m2m:grp"].mt, 0, "0 is MIXED");
  assert.equal(res.body["m2m:grp"].cnm, 2, "both members are kept");
});

test("ABANDON_MEMBER stated explicitly behaves like the default", async () => {
  const res = await mkGroup({ rn: "explicit", mt: MEMBER_TYPE_CONTAINER, mnm: 10, csy: 1, mid: [cnt, ae_id] });

  assert.equal(res.rsc, "2001");
  assert.deepEqual(res.body["m2m:grp"].mid, [cnt]);
});

test("a group created with memberType mixed accepts anything", async () => {
  // mt = 0 means there is nothing to validate. The validation function used to fall off its end
  // and return undefined here, which the caller read as a refusal.
  const res = await mkGroup({ rn: "anymt", mt: 0, mnm: 10, mid: [cnt, ae_id] });

  assert.equal(res.rsc, "2001");
  assert.equal(res.body["m2m:grp"].cnm, 2);
});

test("no create ever answers 2001 without leaving the group behind", async () => {
  // The invariant the original defect broke, checked across every strategy in one place.
  for (const [rn, csy] of [["i1", undefined], ["i2", 1], ["i3", 3]]) {
    const body = { rn, mt: MEMBER_TYPE_CONTAINER, mnm: 10, mid: [cnt, ae_id] };
    if (csy !== undefined) body.csy = csy;

    const res = await mkGroup(body);
    if (res.rsc !== "2001") continue;

    const got = await retrieve(srv.baseUrl, lastMade());
    assert.equal(got.rsc, "2000", `${rn}: reported created (csy=${csy}) but is not there`);
  }
});
