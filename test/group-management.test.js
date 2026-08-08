"use strict";
// Group management conformance, taken from the test purposes in TS-0018 clause 7.2.2.5
// (TP/oneM2M/CSE/GMG/...). Each test names the TP it implements and asserts that TP's
// "Expected behaviour".
//
// All of these are CF01 — one CSE, test system acting as an AE — except CRE/002, UPD/001 and
// UPD/009, which are CF02 (a second CSE holds the member) and are therefore not here. Those
// three turn on what the group-hosting CSE does when it *cannot* read a member's resourceType,
// which is the remote-member question tracked as BACKLOG-042.
//
// <group> cannot be a child of <container> (4108, grp_parent_res_types is ae/rce/cb), so the
// groups and their members live directly under the <CSEBase> and each test cleans up after
// itself rather than sharing one root.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { CSE_BASE, ADMIN, create, retrieve, update, remove, uniqueRn } = require("./helpers/onem2m");
const { startServer } = require("./helpers/server");

let srv;
const toClean = [];

before(async () => {
  srv = await startServer();
});

after(async () => {
  for (const sid of toClean.reverse()) await remove(srv.baseUrl, sid);
  if (srv) await srv.stop();
});

function track(sid) {
  toClean.push(sid);
  return sid;
}

// A <container> directly under the <CSEBase>, usable as a group member.
async function member(prefix = "m") {
  const rn = uniqueRn(prefix);
  const res = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn } });
  assert.equal(res.rsc, "2001", `member setup failed: ${res.raw.slice(0, 200)}`);
  return track(`${CSE_BASE}/${rn}`);
}

// An <AE>, for the cases that need a member whose type differs from <container>.
async function memberAe() {
  const rn = uniqueRn("mae");
  const res = await create(srv.baseUrl, CSE_BASE, 2, { "m2m:ae": { rn, api: "Ngmg.test", rr: true } },
    { originator: "" });
  assert.equal(res.rsc, "2001", `AE member setup failed: ${res.raw.slice(0, 200)}`);
  return track(`${CSE_BASE}/${rn}`);
}

const TY_CNT = 3;
const TY_AE = 2;
const ABANDON_MEMBER = 1;
const ABANDON_GROUP = 2;
const SET_MIXED = 3;

// Creates a <group> under the <CSEBase>. Returns the raw response so a test can assert on a
// rejection as well as on a success.
async function createGroup(over = {}, opts = {}) {
  const rn = uniqueRn("g");
  const res = await create(srv.baseUrl, CSE_BASE, 9, { "m2m:grp": { rn, mnm: 10, ...over } }, opts);
  if (res.rsc === "2001") track(`${CSE_BASE}/${rn}`);
  return { res, sid: `${CSE_BASE}/${rn}`, rn };
}

// An <accessControlPolicy> granting acor the operations in acop, plus the administrator so that
// after() can still clean up. Modelled on test/access-control.test.js.
async function policyGranting(acor, acop) {
  const rn = uniqueRn("acp");
  const res = await create(srv.baseUrl, CSE_BASE, 1, {
    "m2m:acp": {
      rn,
      pv: { acr: [{ acor: [acor], acop }, { acor: [ADMIN], acop: 63 }] },
      pvs: { acr: [{ acor: [ADMIN], acop: 63 }] },
    },
  });
  assert.equal(res.rsc, "2001", `policy setup failed: ${res.raw.slice(0, 200)}`);
  return track(`${CSE_BASE}/${rn}`);
}

// acop bits, TS-0001 table 9.6.2-3.
const ACOP_CREATE = 1;
const ACOP_RETRIEVE = 2;
const ACOP_UPDATE = 4;
const ACOP_DELETE = 8;
const ACOP_ALL = 63;

// ---------------------------------------------------------------------------
// 7.2.2.5.1 CREATE
// ---------------------------------------------------------------------------

test("TP/oneM2M/CSE/GMG/CRE/003 — duplicate memberIDs are removed before the <group> is created", async () => {
  const m1 = await member();

  const { res } = await createGroup({ mt: TY_CNT, mid: [m1, m1] });

  assert.equal(res.rsc, "2001");
  assert.deepEqual(res.body["m2m:grp"].mid, [m1], "the duplicate must not survive creation");
});

test("TP/oneM2M/CSE/GMG/CRE/004 — a <group> whose members all match memberType is created with memberTypeValidated true", async () => {
  const m1 = await member();
  const m2 = await member();

  const { res } = await createGroup({ mt: TY_CNT, mid: [m1, m2] });

  assert.equal(res.rsc, "2001");
  assert.equal(res.body["m2m:grp"].mtv, true);
});

test("TP/oneM2M/CSE/GMG/CRE/005 — with consistencyStrategy SET_MIXED a type mismatch turns the group into a MIXED one", async () => {
  const cnt = await member();
  const ae = await memberAe();

  const { res } = await createGroup({ mt: TY_CNT, csy: SET_MIXED, mid: [cnt, ae] });

  assert.equal(res.rsc, "2001");
  const grp = res.body["m2m:grp"];
  assert.equal(grp.mt, 0, "memberType must have become MIXED");
  assert.equal(grp.mtv, true);
});

test("TP/oneM2M/CSE/GMG/CRE/006 — with consistencyStrategy ABANDON_MEMBER the mismatching member is dropped", async () => {
  const cnt = await member();
  const ae = await memberAe();

  const { res } = await createGroup({ mt: TY_CNT, csy: ABANDON_MEMBER, mid: [cnt, ae] });

  assert.equal(res.rsc, "2001");
  const grp = res.body["m2m:grp"];
  assert.deepEqual(grp.mid, [cnt], "only the member matching memberType survives");
  assert.equal(grp.mtv, true);
});

test("TP/oneM2M/CSE/GMG/CRE/007 — with consistencyStrategy ABANDON_GROUP a type mismatch is rejected 4110 and nothing is created", async () => {
  const cnt = await member();
  const ae = await memberAe();

  const { res, sid } = await createGroup({ mt: TY_CNT, csy: ABANDON_GROUP, mid: [cnt, ae] });

  assert.equal(res.rsc, "4110", "GROUP_MEMBER_TYPE_INCONSISTENT");
  // "the IUT does not create the group resource" is half the expected behaviour, and it is the
  // half that a status-code-only check would miss — this is the shape BACKLOG-063 had.
  const gone = await retrieve(srv.baseUrl, sid);
  assert.equal(gone.rsc, "4004", "a rejected creation must not leave a group behind");
});

test("TP/oneM2M/CSE/GMG/CRE/008 — a <group> with an empty memberIDs attribute is created", async () => {
  const { res } = await createGroup({ mt: TY_CNT, mid: [] });

  assert.equal(res.rsc, "2001", res.raw.slice(0, 300));
  assert.ok(res.body["m2m:grp"], "a group representation comes back");
});

test("TP/oneM2M/CSE/GMG/CRE/001 — more memberIDs than maxNrOfMembers is rejected 6010", async () => {
  const m1 = await member();
  const m2 = await member();

  const { res } = await createGroup({ mt: TY_CNT, mnm: 1, mid: [m1, m2] });

  assert.equal(res.rsc, "6010", "MAX_NUMBER_OF_MEMBER_EXCEEDED");
});

// ---------------------------------------------------------------------------
// 7.2.2.5.2 UPDATE
// ---------------------------------------------------------------------------

test("TP/oneM2M/CSE/GMG/UPD/002 — duplicate memberIDs are removed on UPDATE", async () => {
  const m1 = await member();
  const { sid } = await createGroup({ mt: TY_CNT, mid: [m1] });
  const m2 = await member();

  const res = await update(srv.baseUrl, sid, { "m2m:grp": { mid: [m1, m2, m2] } });

  assert.equal(res.rsc, "2004", res.raw.slice(0, 300));
  assert.deepEqual(res.body["m2m:grp"].mid, [m1, m2]);
});

test("TP/oneM2M/CSE/GMG/UPD/007 — an UPDATE pushing memberIDs past maxNrOfMembers is rejected 6010", async () => {
  const m1 = await member();
  const { sid } = await createGroup({ mt: TY_CNT, mnm: 1, mid: [m1] });
  const m2 = await member();

  const res = await update(srv.baseUrl, sid, { "m2m:grp": { mid: [m1, m2] } });

  assert.equal(res.rsc, "6010");
});

test("TP/oneM2M/CSE/GMG/UPD/008 — an UPDATE setting maxNrOfMembers below the current member count is rejected 6010", async () => {
  const m1 = await member();
  const m2 = await member();
  const { sid } = await createGroup({ mt: TY_CNT, mnm: 5, mid: [m1, m2] });

  const res = await update(srv.baseUrl, sid, { "m2m:grp": { mnm: 1 } });

  assert.equal(res.rsc, "6010");
});

// ---------------------------------------------------------------------------
// 7.2.2.5.3 <fanOutPoint>
// ---------------------------------------------------------------------------

test("TP/oneM2M/CSE/GMG/007 — a fanOutPoint RETRIEVE on a group with no members is rejected 4109", async () => {
  // TS-0004:7.4.14.2.4: "If the parent group has no members, the group-hosting CSE shall reject
  // the request with the Response Status Code indicating NO_MEMBERS."
  const { sid } = await createGroup({ mt: TY_CNT, mid: [] });

  const res = await retrieve(srv.baseUrl, `${sid}/fopt`);

  assert.equal(res.rsc, "4109", `expected NO_MEMBERS, got ${res.rsc} ${res.raw.slice(0, 200)}`);
});

test("TP/oneM2M/CSE/GMG/005_RET — a fanOutPoint RETRIEVE with no relative address reaches every member", async () => {
  const m1 = await member();
  const m2 = await member();
  const { sid } = await createGroup({ mt: TY_CNT, mid: [m1, m2] });

  const res = await retrieve(srv.baseUrl, `${sid}/fopt`);

  assert.equal(res.rsc, "2000");
  const rsp = res.body["m2m:agr"]["m2m:rsp"];
  assert.equal(rsp.length, 2, "one response per member");
  assert.deepEqual(rsp.map((r) => r.fr).sort(), [m1, m2].sort());
  for (const r of rsp) assert.equal(r.rsc, 2000, `member response: ${JSON.stringify(r)}`);
});

test("TP/oneM2M/CSE/GMG/006_RET — a fanOutPoint RETRIEVE with a relative address appended reaches each member's child", async () => {
  const m1 = await member();
  const m2 = await member();
  // Each member gets a child of the same name, which is what the relative path selects.
  const childRn = uniqueRn("child");
  for (const m of [m1, m2]) {
    const r = await create(srv.baseUrl, m, 3, { "m2m:cnt": { rn: childRn } });
    assert.equal(r.rsc, "2001", `child setup failed: ${r.raw.slice(0, 200)}`);
  }
  const { sid } = await createGroup({ mt: TY_CNT, mid: [m1, m2] });

  const res = await retrieve(srv.baseUrl, `${sid}/fopt/${childRn}`);

  assert.equal(res.rsc, "2000");
  const rsp = res.body["m2m:agr"]["m2m:rsp"];
  assert.equal(rsp.length, 2);
  for (const r of rsp) assert.equal(r.rsc, 2000, `member response: ${JSON.stringify(r)}`);
});

test("TP/oneM2M/CSE/GMG/RET/001 — a fanOutPoint RETRIEVE with a virtual resource appended reaches each member's <latest>", async () => {
  const m1 = await member();
  const m2 = await member();
  for (const m of [m1, m2]) {
    const r = await create(srv.baseUrl, m, 4, { "m2m:cin": { con: "42" } });
    assert.equal(r.rsc, "2001", `contentInstance setup failed: ${r.raw.slice(0, 200)}`);
  }
  const { sid } = await createGroup({ mt: TY_CNT, mid: [m1, m2] });

  const res = await retrieve(srv.baseUrl, `${sid}/fopt/la`);

  assert.equal(res.rsc, "2000");
  const rsp = res.body["m2m:agr"]["m2m:rsp"];
  assert.equal(rsp.length, 2);
  for (const r of rsp) {
    assert.equal(r.rsc, 2000, `member response: ${JSON.stringify(r)}`);
    assert.equal(r.pc["m2m:cin"].con, "42");
  }
});

// GMG/001..004 are about which policy decides a fanout: membersAccessControlPolicyIDs when it is
// present, accessControlPolicyIDs otherwise (TS-0004:7.4.14.3.2, "In the case the
// membersAccessControlPolicyIDs is not provided, the accessControlPolicyIDs of the parent
// <group> resource shall be used"). Both are exercised in both directions.

const FANOUT_AE = "Cgmgfan";

test("TP/oneM2M/CSE/GMG/001_RET — a fanOutPoint RETRIEVE is allowed by membersAccessControlPolicyIDs", async () => {
  const m1 = await member();
  const acp = await policyGranting(FANOUT_AE, ACOP_RETRIEVE);
  const { sid } = await createGroup({ mt: TY_CNT, mid: [m1], macp: [acp] });

  const res = await retrieve(srv.baseUrl, `${sid}/fopt`, { originator: FANOUT_AE });

  assert.equal(res.rsc, "2000", res.raw.slice(0, 300));
  assert.ok(res.body["m2m:agr"]);
});

test("TP/oneM2M/CSE/GMG/002_RET — a fanOutPoint RETRIEVE is denied 4103 when membersAccessControlPolicyIDs withholds it", async () => {
  const m1 = await member();
  // Everything except retrieve.
  const acp = await policyGranting(FANOUT_AE, ACOP_ALL - ACOP_RETRIEVE);
  const { sid } = await createGroup({ mt: TY_CNT, mid: [m1], macp: [acp] });

  const res = await retrieve(srv.baseUrl, `${sid}/fopt`, { originator: FANOUT_AE });

  assert.equal(res.rsc, "4103", "ORIGINATOR_HAS_NO_PRIVILEGE");
});

test("TP/oneM2M/CSE/GMG/003_RET — with no membersAccessControlPolicyIDs the group's own accessControlPolicyIDs allows the fanout", async () => {
  const m1 = await member();
  const acp = await policyGranting(FANOUT_AE, ACOP_RETRIEVE);
  const { sid } = await createGroup({ mt: TY_CNT, mid: [m1], acpi: [acp] });

  const res = await retrieve(srv.baseUrl, `${sid}/fopt`, { originator: FANOUT_AE });

  assert.equal(res.rsc, "2000", res.raw.slice(0, 300));
});

test("TP/oneM2M/CSE/GMG/004_RET — with no membersAccessControlPolicyIDs a withholding accessControlPolicyIDs denies the fanout 4103", async () => {
  const m1 = await member();
  const acp = await policyGranting(FANOUT_AE, ACOP_ALL - ACOP_RETRIEVE);
  const { sid } = await createGroup({ mt: TY_CNT, mid: [m1], acpi: [acp] });

  const res = await retrieve(srv.baseUrl, `${sid}/fopt`, { originator: FANOUT_AE });

  assert.equal(res.rsc, "4103");
});
