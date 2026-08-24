"use strict";
// A virtual resource is addressed by a whole path segment, and the parent's own name has no
// say in it.
//
// <latest>, <oldest> and <fanOutPoint> are virtual child resources (TS-0001:9.6.6, 9.6.7,
// 9.6.14): they are addressed as "la", "ol" and "fopt" appended to the parent's address, and
// nothing in the spec makes that addressing depend on what the parent is called. mobius4 found
// them with to.includes("/" + name), which is a substring test, so in "Mobius/temp1/lamp/la"
// the first "/la" matched inside "/lamp" — the parent came out as "Mobius/temp1", the leftover
// as "mp/la", and the guard meant to separate "cnt/la" from "cnt/later" then returned out of
// the whole lookup. The request was handled as an ordinary RETRIEVE of a resource that does not
// exist and answered 4004. Every parent whose name merely *starts with* one of the three names
// lost its virtual children (BACKLOG-118, found while a container named "lamp" made a Grafana
// panel go blank).
//
// The test purposes are TP/oneM2M/CSE/DMR/RET/012 (<latest>) and TP/oneM2M/CSE/DMR/RET/010
// (<oldest>), which are already exercised elsewhere with generated names. TS-0018 has no test
// purpose for the name collision itself — checked by searching all five source files for the
// virtual resource names — so the collision is pinned here by running those two TPs over a set
// of parent names chosen to straddle the boundary. The control names matter as much as the
// colliding ones: they are what says the fix did not simply turn the guard off.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, retrieve, remove, createRoot, uniqueRn } = require("./helpers/onem2m");

const CSE_BASE = "Mobius"; // config.cse.csebase_rn — <group> is not allowed under a <container>

const TY_CNT = 3, TY_CIN = 4, TY_GRP = 9;

// "lamp" is the name the freeboard course hands out for the LED container, which is how this
// surfaced. The rest walk the boundary in both directions: a prefix that is exactly the virtual
// name plus more ("later", "fopta"), a prefix that shares only its opening letters ("label"),
// and names that collide with nothing ("led", "DATA"). "olive" is here because it is the one
// colliding name that used to answer correctly for /la — "/la" does not occur in "/olive/la"
// before the end — and so would have hidden the bug if it had been the only case tried.
const PARENT_NAMES = ["lamp", "later", "label", "olive", "fopta", "led", "DATA"];

let srv, root;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "vra");
});

after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
});

// A <container> of the given name holding two <contentInstance>s, oldest first. Their names are
// generated and random, so only the CSE's own ordering can say which is which — the same
// property test/result-ordering.test.js relies on.
async function containerWithTwoInstances(rn) {
  const c = await create(srv.baseUrl, root.sid, TY_CNT, { "m2m:cnt": { rn } });
  assert.equal(c.rsc, "2001", `setup, create container ${rn}: ${c.raw.slice(0, 200)}`);
  const sid = `${root.sid}/${rn}`;
  const names = [];
  for (const con of [`${rn}-first`, `${rn}-second`]) {
    const ci = await create(srv.baseUrl, sid, TY_CIN, { "m2m:cin": { con } });
    assert.equal(ci.rsc, "2001", `setup, create <cin> under ${rn}: ${ci.raw.slice(0, 200)}`);
    names.push(ci.body["m2m:cin"].rn);
  }
  return { sid, oldest: names[0], newest: names[1] };
}

for (const rn of PARENT_NAMES) {
  test(`TP/oneM2M/CSE/DMR/RET/012 — <latest> of a <container> named "${rn}"`, async () => {
    const { sid, newest } = await containerWithTwoInstances(`${rn}-la-${uniqueRn("")}`);

    const res = await retrieve(srv.baseUrl, `${sid}/la`);

    assert.equal(res.rsc, "2000", `${sid}/la answered ${res.rsc}: ${res.raw.slice(0, 200)}`);
    assert.equal(res.body["m2m:cin"].rn, newest);
  });

  test(`TP/oneM2M/CSE/DMR/RET/010 — <oldest> of a <container> named "${rn}"`, async () => {
    const { sid, oldest } = await containerWithTwoInstances(`${rn}-ol-${uniqueRn("")}`);

    const res = await retrieve(srv.baseUrl, `${sid}/ol`);

    assert.equal(res.rsc, "2000", `${sid}/ol answered ${res.rsc}: ${res.raw.slice(0, 200)}`);
    assert.equal(res.body["m2m:cin"].rn, oldest);
  });
}

test("a <group> named after fanOutPoint's prefix still fans out", async () => {
  // The <fanOutPoint> half of the same defect. "fopt" is checked before "la" and "ol" so that
  // "grp/fopt/la" is the group's fanOutPoint with "la" as the relative path rather than the
  // other way round; a name-shaped match has to keep that ordering intact.
  const memberRn = uniqueRn("fmember");
  const m = await create(srv.baseUrl, root.sid, TY_CNT, { "m2m:cnt": { rn: memberRn } });
  assert.equal(m.rsc, "2001", `setup, create member: ${m.raw.slice(0, 200)}`);
  const memberSid = `${root.sid}/${memberRn}`;
  const ci = await create(srv.baseUrl, memberSid, TY_CIN, { "m2m:cin": { con: "42" } });
  assert.equal(ci.rsc, "2001", `setup, create <cin>: ${ci.raw.slice(0, 200)}`);

  // A <group> may not be a child of a <container>, so this one lives under the <CSEBase> and
  // is removed here rather than with the rest of the tree.
  const grpRn = `fopt-group-${uniqueRn("")}`;
  const g = await create(srv.baseUrl, CSE_BASE, TY_GRP, {
    "m2m:grp": { rn: grpRn, mt: TY_CNT, mnm: 5, mid: [memberSid] },
  });
  assert.equal(g.rsc, "2001", `setup, create group: ${g.raw.slice(0, 200)}`);
  const grpSid = `${CSE_BASE}/${grpRn}`;

  try {
    const res = await retrieve(srv.baseUrl, `${grpSid}/fopt/la`);

    assert.equal(res.rsc, "2000", `${grpSid}/fopt/la answered ${res.rsc}: ${res.raw.slice(0, 200)}`);
    const rsp = res.body["m2m:agr"]["m2m:rsp"];
    assert.equal(rsp.length, 1);
    assert.equal(rsp[0].rsc, 2000, `member response: ${JSON.stringify(rsp[0])}`);
    assert.equal(rsp[0].pc["m2m:cin"].con, "42");
  } finally {
    await remove(srv.baseUrl, grpSid);
  }
});

test("a child whose name only begins with a virtual resource name is still an ordinary child", async () => {
  // The other direction, and the reason the old guard existed: "cnt/later" must not be read as
  // "cnt/la" with a leftover. If the segment match were loosened to a prefix match this is the
  // test that would fail, so it is what keeps the fix honest rather than merely permissive.
  const cntRn = uniqueRn("holder");
  const c = await create(srv.baseUrl, root.sid, TY_CNT, { "m2m:cnt": { rn: cntRn } });
  assert.equal(c.rsc, "2001", `setup, create container: ${c.raw.slice(0, 200)}`);
  const cntSid = `${root.sid}/${cntRn}`;
  await create(srv.baseUrl, cntSid, TY_CIN, { "m2m:cin": { con: "in the container" } });

  for (const childRn of ["later", "older", "foptional"]) {
    const child = await create(srv.baseUrl, cntSid, TY_CNT, { "m2m:cnt": { rn: childRn } });
    assert.equal(child.rsc, "2001", `create child ${childRn}: ${child.raw.slice(0, 200)}`);

    const res = await retrieve(srv.baseUrl, `${cntSid}/${childRn}`);
    assert.equal(res.rsc, "2000", `${cntSid}/${childRn} answered ${res.rsc}`);
    // A <container>, not the parent's newest <contentInstance>.
    assert.equal(res.body["m2m:cnt"].rn, childRn);
  }
});

test("the virtual resource names themselves are still refused as a resourceName", async () => {
  // What lets the segment match assume the first matching segment is the virtual resource: no
  // real resource can carry one of these names (TS-0001:9.6.6 — <latest> is a child of every
  // <container>, so the name is taken). If this guard ever went away, "cnt/la/la" would become
  // ambiguous.
  for (const rn of ["la", "ol", "fopt"]) {
    const res = await create(srv.baseUrl, root.sid, TY_CNT, { "m2m:cnt": { rn } });
    assert.equal(res.rsc, "4005", `create a <container> named "${rn}" answered ${res.rsc}`);
  }
});
