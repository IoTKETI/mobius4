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
const { create, remove, retrieve, update, discover, urils, createRoot, uniqueRn, CSE_BASE, ADMIN } =
  require("./helpers/onem2m");

const ADMIN_ACP = `${CSE_BASE}/cb_admin_acp`;      // config.cb.admin_acp.rn
const DEFAULT_ACP = `${CSE_BASE}/cb_default_acp`;  // config.cb.default_acp.rn

// Someone who is neither the administrator nor, below, the creator of the resource under test.
const OTHER_AE = "CAE-other";
const THIRD_AE = "CAE-third";

let srv, root, parent;

// <accessControlPolicy> resources created by the CIN tests below. They have to live under the
// <CSEBase> (a container is not a permitted parent for ty=1), so the test root's own deletion
// does not reach them and the after() hook clears them explicitly.
const acpsToClean = [];

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

// One after() for the whole file: node:test runs them in registration order, so a second one
// declared further down would fire after srv.stop() and every request in it would fail.
after(async () => {
  for (const sid of acpsToClean) await remove(srv.baseUrl, sid);
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

// ---------------------------------------------------------------------------
// A <contentInstance> is governed by its parent's policy.
//
// TS-0001:9.6.7: "The <contentInstance> resource inherits the same access control policies of
// the parent <container> resource, and does not have its own accessControlPolicyIDs
// attribute." TS-0001:9.6.1.3.2 states the general rule these fall under — a resource type
// with no accessControlPolicyIDs definition is governed some other way, the parent's policy
// being the named example.
//
// access_decision implements this as Case B: resolve the parent, then ask the same question
// about the parent instead. Until 2026-08-06 the request it built for that recursive call
// carried to_ty, ri and fr but *not* op, and access_decision_acpi switches on the operation —
// so an undefined op matched no case and every rule evaluated to false. The effect was that a
// <contentInstance> under a container carrying any acpi was unreachable by everyone, the
// administrator included, and vanished from discovery results.
//
// It stayed hidden because a container created without an acpi falls through to the creator
// comparison instead, and fr *was* carried — so the common shape (an AE reading back what it
// wrote into its own container) worked, and every test here predates the CIN cases below.
//
// The third test is the one that distinguishes "op is carried" from "op is ignored": it needs
// the retrieve bit to be honoured and the delete bit to be honoured separately.

// An <accessControlPolicy> under the <CSEBase> granting acor the operations in acop. The
// administrator is named as well, in privileges so that it can set the resources up and in
// selfPrivileges so that after() can delete the policy again. That extra rule never decides any
// assertion below: the originator under test is always OTHER_AE or THIRD_AE.
async function policyGranting(acor, acop) {
  const rn = uniqueRn("acp");
  const res = await create(srv.baseUrl, CSE_BASE, 1, { "m2m:acp": {
    rn,
    pv:  { acr: [{ acor: [acor], acop }, { acor: [ADMIN], acop: 63 }] },
    pvs: { acr: [{ acor: [ADMIN], acop: 63 }] },
  }});
  assert.equal(res.rsc, "2001", `policy setup failed: ${res.raw.slice(0, 200)}`);
  const sid = `${CSE_BASE}/${rn}`;
  acpsToClean.push(sid);
  return sid;
}

// A container under the test root carrying acpi, plus one <contentInstance> inside it, both put
// there by the administrator. Who created them does not enter into any of these decisions — the
// container has an acpi, so the creator fallback is not reached at all — and setting them up as
// the administrator is what lets a policy that names nobody else still be testable.
async function containerWithOneCin(acpi) {
  const rn = uniqueRn("c");
  const cnt = await create(srv.baseUrl, parent, 3, { "m2m:cnt": { rn, acpi: [acpi] } });
  assert.equal(cnt.rsc, "2001", `container setup failed: ${cnt.raw.slice(0, 200)}`);
  const cntSid = `${parent}/${rn}`;

  const cin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: "42" } });
  assert.equal(cin.rsc, "2001", `contentInstance setup failed: ${cin.raw.slice(0, 200)}`);
  return { cntSid, cinSid: `${cntSid}/${cin.body["m2m:cin"].rn}` };
}

test("a <contentInstance> is reachable through the policy on its parent <container>", async () => {
  const acp = await policyGranting(OTHER_AE, 63);
  const { cinSid } = await containerWithOneCin(acp);

  const res = await retrieve(srv.baseUrl, cinSid, { originator: OTHER_AE });
  assert.equal(res.rsc, "2000",
    "the parent's policy grants retrieve, and the child inherits it (TS-0001:9.6.7)");
  assert.equal(res.body["m2m:cin"].con, "42");
});

test("the parent's policy decides for the child: an originator it does not name is refused", async () => {
  // The mirror of the test above. Carrying the operation into the parent's decision must not
  // turn into granting the operation.
  const acp = await policyGranting(OTHER_AE, 63);
  const { cinSid } = await containerWithOneCin(acp);

  const res = await retrieve(srv.baseUrl, cinSid, { originator: THIRD_AE });
  assert.equal(res.rsc, "4103", "THIRD_AE is named by neither the policy nor the creator");
});

test("the operation is carried into the parent's decision, not assumed", async () => {
  // acop 35 = create(1) + retrieve(2) + discovery(32), no delete bit. If the recursive call
  // dropped op, both of these would be 4103; if it substituted a permissive one, both would
  // succeed. Only carrying the real operation gives 2000 then 4103.
  const acp = await policyGranting(OTHER_AE, 35);
  const { cinSid } = await containerWithOneCin(acp);

  const read = await retrieve(srv.baseUrl, cinSid, { originator: OTHER_AE });
  assert.equal(read.rsc, "2000", "the retrieve bit is set");

  const del = await remove(srv.baseUrl, cinSid, { originator: OTHER_AE });
  assert.equal(del.rsc, "4103", "the delete bit is not set, and the child must feel that too");
});

// discovery_core memoizes each access decision by whatever actually decides it — the parent's
// ri for a parent-governed type, the resource's own ri otherwise — so that N content instances
// under one container cost one decision instead of N. These two tests are what keeps that from
// becoming "one decision for everybody".

test("discovery keeps <contentInstance> decisions apart when their parents' policies differ", async () => {
  const open = await policyGranting(OTHER_AE, 35);   // OTHER may discover
  const shut = await policyGranting(THIRD_AE, 35);   // OTHER may not
  const a = await containerWithOneCin(open);
  const b = await containerWithOneCin(shut);

  const res = await discover(srv.baseUrl, parent, {}, { originator: OTHER_AE });
  assert.equal(res.rsc, "2000");
  const found = urils(res);

  assert.ok(found.includes(a.cinSid), `the permitted CIN is missing: ${JSON.stringify(found)}`);
  assert.ok(!found.includes(b.cinSid),
    `a CIN under a policy that does not name this originator leaked in: ${JSON.stringify(found)}`);
});

test("a change to an <accessControlPolicy>'s privileges takes effect on the very next request", async () => {
  // The question the memo has to answer for: nothing in access control keys off acpi, so an
  // <acp> whose pv changes must be felt immediately. Two originators disagreeing (the test
  // below) only shows the memo is per-originator; this one changes the policy itself, which is
  // the case a cache with any lifetime beyond one request would get wrong.
  //
  // It covers both paths that read privileges: the <container> decides for itself (Case D) and
  // the <contentInstance> inherits that decision through its parent (Case B). Discovery is
  // included because that is where the memo lives.
  const rn = uniqueRn("acp");
  const made = await create(srv.baseUrl, CSE_BASE, 1, { "m2m:acp": {
    rn,
    pv:  { acr: [{ acor: [OTHER_AE], acop: 35 }, { acor: [ADMIN], acop: 63 }] },
    pvs: { acr: [{ acor: [ADMIN], acop: 63 }] },
  }});
  assert.equal(made.rsc, "2001", `policy setup failed: ${made.raw.slice(0, 200)}`);
  const acpSid = `${CSE_BASE}/${rn}`;
  acpsToClean.push(acpSid);

  const { cntSid, cinSid } = await containerWithOneCin(acpSid);

  // granted
  assert.equal((await retrieve(srv.baseUrl, cinSid, { originator: OTHER_AE })).rsc, "2000");
  assert.ok(urils(await discover(srv.baseUrl, cntSid, {}, { originator: OTHER_AE })).includes(cinSid));

  // revoke: OTHER_AE drops out of privileges entirely
  const revoked = await update(srv.baseUrl, acpSid, { "m2m:acp": {
    pv: { acr: [{ acor: [ADMIN], acop: 63 }] },
  }});
  assert.equal(revoked.rsc, "2004", `pv update failed: ${revoked.raw.slice(0, 200)}`);

  assert.equal((await retrieve(srv.baseUrl, cinSid, { originator: OTHER_AE })).rsc, "4103",
    "the revocation must be felt on the next request, with no cache to wait out");
  assert.ok(!urils(await discover(srv.baseUrl, cntSid, {}, { originator: OTHER_AE })).includes(cinSid),
    "a revoked originator must stop seeing the CIN in discovery immediately");

  // and back again, so this cannot pass by way of something that only ever denies
  const restored = await update(srv.baseUrl, acpSid, { "m2m:acp": {
    pv: { acr: [{ acor: [OTHER_AE], acop: 35 }, { acor: [ADMIN], acop: 63 }] },
  }});
  assert.equal(restored.rsc, "2004", `pv restore failed: ${restored.raw.slice(0, 200)}`);

  assert.equal((await retrieve(srv.baseUrl, cinSid, { originator: OTHER_AE })).rsc, "2000",
    "a re-grant must be felt just as immediately");
  assert.ok(urils(await discover(srv.baseUrl, cntSid, {}, { originator: OTHER_AE })).includes(cinSid));
});

test("the discovery decision memo does not outlive the request", async () => {
  // Two originators, opposite answers, back to back against the same resources. A memo promoted
  // to module scope or given a TTL would hand the second request the first one's answers — the
  // exact failure mode that makes cross-request caching of access decisions unsound.
  const open = await policyGranting(OTHER_AE, 35);
  const shut = await policyGranting(THIRD_AE, 35);
  const a = await containerWithOneCin(open);
  const b = await containerWithOneCin(shut);

  const asOther = urils(await discover(srv.baseUrl, parent, {}, { originator: OTHER_AE }));
  const asThird = urils(await discover(srv.baseUrl, parent, {}, { originator: THIRD_AE }));

  assert.ok(asOther.includes(a.cinSid) && !asOther.includes(b.cinSid), "first request");
  assert.ok(asThird.includes(b.cinSid) && !asThird.includes(a.cinSid),
    `the second originator got the first one's answers: ${JSON.stringify(asThird)}`);
});

test("discovery lists a <contentInstance> that its parent's policy makes discoverable", async () => {
  // Discovery evaluates each discovered resource with op=6, so it travels the same Case B
  // path. With op dropped, the CIN was silently filtered out of every result — a 2000 with an
  // empty list, which is far quieter than a 4103.
  const acp = await policyGranting(OTHER_AE, 35);
  const { cntSid, cinSid } = await containerWithOneCin(acp);

  const res = await discover(srv.baseUrl, cntSid, {}, { originator: OTHER_AE });
  assert.equal(res.rsc, "2000");
  assert.ok(urils(res).includes(cinSid),
    `the CIN should appear in the discovery result: ${JSON.stringify(urils(res))}`);
});
