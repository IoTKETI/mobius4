"use strict";
// The administrator's privileges come from an <accessControlPolicy>, not from a short-circuit.
//
// Until v4.6.0, cse/hostingCSE.js granted the administrator every operation before any policy
// was read. That check is gone; db/init.js now creates an admin <accessControlPolicy>
// (config.cb.admin_acp) granting acop 63, and the administrator reaches a resource the same
// way anyone else does.
//
// These tests pin the replacement down. Passing the suite without them would prove little:
// most resources in the other tests are created by the administrator itself, so they would go
// on working through the creator fallback (Case D in access_decision) even if the admin policy
// did nothing at all.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, remove, retrieve, createRoot, uniqueRn, CSE_BASE, ADMIN } = require("./helpers/onem2m");

const ADMIN_ACP = `${CSE_BASE}/cb_admin_acp`;      // config.cb.admin_acp.rn
const DEFAULT_ACP = `${CSE_BASE}/cb_default_acp`;  // config.cb.default_acp.rn

// Someone who is neither the administrator nor, below, the creator of the resource under test.
const OTHER_AE = "CAE-other";
const THIRD_AE = "CAE-third";

let srv, root, parent;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "acl");

  // The parent has to carry the default policy for these tests to be able to set up at all.
  // createRoot makes its container as the administrator with no acpi, which now means the
  // creator fallback governs it and nobody else can create underneath — a direct consequence
  // of removing the administrator short-circuit, and worth seeing here rather than only in
  // the assertions below.
  const rn = uniqueRn("p");
  const res = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn, acpi: [DEFAULT_ACP] } });
  assert.equal(res.rsc, "2001", `setup failed: ${res.raw.slice(0, 200)}`);
  parent = `${root.sid}/${rn}`;
});

after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
});

// A container created by someone other than the administrator, carrying the policies named.
async function containerOwnedByOther(acpi) {
  const rn = uniqueRn("c");
  const res = await create(srv.baseUrl, parent, 3, { "m2m:cnt": { rn, acpi } },
    { originator: OTHER_AE });
  assert.equal(res.rsc, "2001", `setup failed: ${res.raw.slice(0, 200)}`);
  return `${parent}/${rn}`;
}

test("the admin policy exists and grants the administrator all six operations", async () => {
  const res = await retrieve(srv.baseUrl, ADMIN_ACP);
  assert.equal(res.rsc, "2000", "db/init.js should have created the admin policy at startup");

  const acp = res.body["m2m:acp"];
  const rule = acp.pv.acr.find((r) => r.acor.includes(ADMIN));
  assert.ok(rule, `privileges should name the administrator: ${JSON.stringify(acp.pv)}`);
  assert.equal(rule.acop, 63, "acop 63 is all six operations");
});

test("the administrator can delete a resource it did not create, through the admin policy", async () => {
  // This is the case the removed short-circuit used to cover, and the one that proves the
  // replacement works. The creator fallback does not apply (OTHER_AE created it) and the
  // default policy cannot help either — its acop is 35, which has no delete bit (code map G-2).
  const sid = await containerOwnedByOther([DEFAULT_ACP, ADMIN_ACP]);

  const res = await remove(srv.baseUrl, sid);
  assert.equal(res.rsc, "2002", "the admin policy should grant delete");
});

test("an ordinary originator still cannot delete someone else's resource", async () => {
  // The mirror of the test above: the grant has to come from the admin policy naming the
  // administrator, not from the resource being reachable at all.
  const sid = await containerOwnedByOther([DEFAULT_ACP, ADMIN_ACP]);

  const res = await remove(srv.baseUrl, sid, { originator: THIRD_AE });
  assert.equal(res.rsc, "4103", "only the identity named in the admin policy gets these rights");
});

test("without the admin policy the administrator has no special rights", async () => {
  // The point of the change: there is no longer an identity that bypasses access control. A
  // resource carrying only the default policy is not deletable by the administrator, because
  // that policy grants create/retrieve/discovery and nothing else.
  const sid = await containerOwnedByOther([DEFAULT_ACP]);

  const res = await remove(srv.baseUrl, sid);
  assert.equal(res.rsc, "4103",
    "the administrator should be refused when no policy on the resource grants it delete");
});

test("a resource with no acpi still falls back to its creator, and the administrator is not it", async () => {
  // Resources with an empty acpi are deliberately left alone by db/migrations/v4.6.0.sql:
  // giving them a policy would switch them from the creator fallback to policy evaluation and
  // their creator would lose update and delete. The consequence is asserted here rather than
  // left implicit — the administrator's reach into such resources now follows the same rule as
  // everyone else's.
  const sid = await containerOwnedByOther(undefined);

  const res = await remove(srv.baseUrl, sid);
  assert.equal(res.rsc, "4103", "creator fallback applies to the administrator too");

  // ...and the creator itself is still able to delete it, which is what the fallback protects.
  const byCreator = await remove(srv.baseUrl, sid, { originator: OTHER_AE });
  assert.equal(byCreator.rsc, "2002");
});
