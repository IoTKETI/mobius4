"use strict";
// Groups whose members live on another CSE — the CF02 test purposes of TS-0018 clause 7.2.2.5,
// plus the fanout behaviour they imply. The CF01 group tests are in
// test/group-management.test.js.
//
// What was wrong before this file existed (measured 2026-08-08 against two CSEs):
// memberType_validation resolved a member's resourceType with a local lookup only. A member on
// another CSE came back as type 0, which is indistinguishable from a type mismatch, so the
// default consistency strategy (ABANDON_MEMBER) dropped it — and the group was still reported
// with memberTypeValidated = true. The CSE asserted it had validated a member it had never read,
// and the Originator got a 2001 for a group that quietly had one fewer member than it asked for.
//
// TS-0004:7.4.13.2.1 splits this into three outcomes, and they are what this file pins down:
//   readable      -> use the type that came back, then apply the consistency strategy
//   no privilege  -> reject the whole request, RECEIVER_HAS_NO_PRIVILEGE
//   unreachable   -> keep the member, set memberTypeValidated to false, answer normally

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { CSE_BASE, ADMIN, create, retrieve, update, remove, uniqueRn } = require("./helpers/onem2m");
const { startTwoCSEs } = require("./helpers/two-cse");

let env;
let A; // the group-hosting CSE, and the IUT throughout
let B; // the member-hosting CSE

before(async () => {
  env = await startTwoCSEs();
  A = env.a.baseUrl;
  B = env.b.baseUrl;
});

after(async () => {
  if (env) await env.stop();
});

const TY_CNT = 3;
const ABANDON_MEMBER = 1;

// A <container> on A, addressed the way a local member is.
async function localMember() {
  const rn = uniqueRn("loc");
  const res = await create(A, CSE_BASE, 3, { "m2m:cnt": { rn } });
  assert.equal(res.rsc, "2001", `local member setup failed: ${res.raw.slice(0, 200)}`);
  return `${CSE_BASE}/${rn}`;
}

// A <container> on B, addressed from A as an SP-relative ID: /{B's CSE-ID}/{structured path}.
// That is the form that goes into memberIDs; the /~/ prefix is only how HTTP carries an
// SP-relative To (TS-0009:6.2.2.1) and does not belong in the attribute.
async function remoteMember(over = {}) {
  const rn = uniqueRn("rem");
  const res = await create(B, CSE_BASE, 3,
    { "m2m:cnt": { rn, acpi: [await openPolicyOnB()], ...over } });
  assert.equal(res.rsc, "2001", `remote member setup failed: ${res.raw.slice(0, 200)}`);
  return `${env.b.cseId}/${CSE_BASE}/${rn}`;
}

// An <accessControlPolicy> on B that lets anybody retrieve. Without it, a resource created on B
// falls back to the default policy, which is creator-only, and A's originator gets 4103 —
// turning every remote-member test into the no-privilege case regardless of what it meant to
// test. "*" is the wildcard originator (cse/hostingCSE.js access_decision_acpi).
let openAcpOnB;
async function openPolicyOnB() {
  if (openAcpOnB) return openAcpOnB;
  const rn = uniqueRn("open");
  const res = await create(B, CSE_BASE, 1, {
    "m2m:acp": {
      rn,
      pv: { acr: [{ acor: ["*"], acop: 63 }] },
      pvs: { acr: [{ acor: [ADMIN], acop: 63 }] },
    },
  });
  assert.equal(res.rsc, "2001", `open ACP setup failed: ${res.raw.slice(0, 200)}`);
  openAcpOnB = `${CSE_BASE}/${rn}`;
  return openAcpOnB;
}

// An <AE> on B that anybody may retrieve — a remote member whose type is readable but wrong for
// a container group.
async function remoteAeMember() {
  const rn = uniqueRn("rae");
  const res = await create(B, CSE_BASE, 2,
    { "m2m:ae": { rn, api: "Nrem.test", rr: true, acpi: [await openPolicyOnB()] } },
    { originator: "" });
  assert.equal(res.rsc, "2001", `remote AE setup failed: ${res.raw.slice(0, 200)}`);
  return `${env.b.cseId}/${CSE_BASE}/${rn}`;
}

async function createGroup(over = {}, opts = {}) {
  const rn = uniqueRn("g");
  const res = await create(A, CSE_BASE, 9, { "m2m:grp": { rn, mnm: 10, ...over } }, opts);
  return { res, sid: `${CSE_BASE}/${rn}` };
}

// ---------------------------------------------------------------------------
// A reachable member on another CSE
// ---------------------------------------------------------------------------

test("a <group> keeps a reachable remote member and validates its type", async () => {
  const local = await localMember();
  const remote = await remoteMember();

  const { res } = await createGroup({ mt: TY_CNT, mid: [local, remote] });

  assert.equal(res.rsc, "2001", res.raw.slice(0, 300));
  const grp = res.body["m2m:grp"];
  assert.deepEqual(grp.mid, [local, remote], "the remote member must survive creation");
  assert.equal(grp.cnm, 2);
  assert.equal(grp.mtv, true, "both types were read, so the group is validated");
});

test("a remote member of the wrong type is dropped by ABANDON_MEMBER, like a local one", async () => {
  // The point is that the remote member is judged on its actual type rather than on the CSE's
  // inability to see it: an <AE> on B is dropped from a container group, a <container> is not.
  const local = await localMember();
  const remoteWrongType = await remoteAeMember();

  const { res } = await createGroup({ mt: TY_CNT, csy: ABANDON_MEMBER, mid: [local, remoteWrongType] });

  assert.equal(res.rsc, "2001");
  assert.deepEqual(res.body["m2m:grp"].mid, [local], "the remote <AE> does not belong in a container group");
  assert.equal(res.body["m2m:grp"].mtv, true);
});

test("a fanOutPoint RETRIEVE reaches a member on another CSE", async () => {
  const local = await localMember();
  const remote = await remoteMember();
  const { sid } = await createGroup({ mt: TY_CNT, mid: [local, remote] });

  const res = await retrieve(A, `${sid}/fopt`);

  assert.equal(res.rsc, "2000");
  const rsp = res.body["m2m:agr"]["m2m:rsp"];
  assert.equal(rsp.length, 2, "one response per member, remote included");
  // TS-0004:7.4.14.2.5: "the Hosting CSE shall set that member's resource ID into the From
  // response parameter in each member response."
  assert.deepEqual(rsp.map((r) => r.fr).sort(), [local, remote].sort());
  for (const r of rsp) {
    // responseStatusCode is xs:integer (TS-0004 CDT-enumerationTypes.xsd). Forwarded responses
    // used to carry the HTTP header verbatim, so one member answered 2000 and the other "2000"
    // inside the same aggregation.
    assert.equal(typeof r.rsc, "number", `rsc must be a number, got ${JSON.stringify(r.rsc)}`);
    assert.equal(r.rsc, 2000);
  }
});

// ---------------------------------------------------------------------------
// TP/oneM2M/CSE/GMG/CRE/002 and UPD/001 — the member's type cannot be read
// ---------------------------------------------------------------------------

// An <accessControlPolicy> on B that grants nothing to anyone but B's own administrator, and a
// <container> under it. A retrieving that container on behalf of an AE gets 4103 from B.
async function unreadableRemoteMember() {
  const acpRn = uniqueRn("acp");
  const acp = await create(B, CSE_BASE, 1, {
    "m2m:acp": {
      rn: acpRn,
      pv: { acr: [{ acor: [ADMIN], acop: 63 }] },
      pvs: { acr: [{ acor: [ADMIN], acop: 63 }] },
    },
  });
  assert.equal(acp.rsc, "2001", `remote ACP setup failed: ${acp.raw.slice(0, 200)}`);

  const rn = uniqueRn("priv");
  const res = await create(B, CSE_BASE, 3, { "m2m:cnt": { rn, acpi: [`${CSE_BASE}/${acpRn}`] } });
  assert.equal(res.rsc, "2001", `restricted member setup failed: ${res.raw.slice(0, 200)}`);
  return `${env.b.cseId}/${CSE_BASE}/${rn}`;
}

test("TP/oneM2M/CSE/GMG/CRE/002 — a <group> CREATE is rejected 5105 when a member's type cannot be read for lack of privilege", async () => {
  const restricted = await unreadableRemoteMember();

  // Originating as an AE rather than as A's administrator: the administrator identity means
  // nothing on B, but it is a plain unprivileged originator there either way, and using an AE
  // keeps the test honest about who is asking.
  const { res, sid } = await createGroup(
    { mt: TY_CNT, mid: [restricted] },
    { originator: "Cgrpremote" }
  );

  assert.equal(res.rsc, "5105", `expected RECEIVER_HAS_NO_PRIVILEGE, got ${res.rsc} ${res.raw.slice(0, 200)}`);
  const gone = await retrieve(A, sid);
  assert.equal(gone.rsc, "4004", "a rejected creation must not leave a group behind");
});

test("TP/oneM2M/CSE/GMG/UPD/001 — a <group> UPDATE is rejected 5105 when the added member's type cannot be read", async () => {
  const local = await localMember();
  // Created by the same originator that will update it: otherwise A refuses the UPDATE itself
  // with 4103 and the member validation never runs, which would make this test pass for the
  // wrong reason.
  const { res: created, sid } = await createGroup({ mt: TY_CNT, mid: [local] },
    { originator: "Cgrpremote" });
  assert.equal(created.rsc, "2001", created.raw.slice(0, 300));
  const restricted = await unreadableRemoteMember();

  const res = await update(A, sid, { "m2m:grp": { mid: [local, restricted] } },
    { originator: "Cgrpremote" });

  assert.equal(res.rsc, "5105", res.raw.slice(0, 300));
  const after = await retrieve(A, sid, { originator: "Cgrpremote" });
  assert.deepEqual(after.body["m2m:grp"].mid, [local], "a rejected update must not change the members");
});

// ---------------------------------------------------------------------------
// TP/oneM2M/CSE/GMG/UPD/009 — the member's CSE is temporarily unreachable
// ---------------------------------------------------------------------------

// Registers a <remoteCSE> on A whose pointOfAccess nobody is listening on, and returns a member
// ID hosted "on" it. Forwarding to it fails at the transport, which is what "temporarily
// unreachable" means here — as opposed to a CSE that answers and refuses.
async function unreachableRemoteMember() {
  const csi = `/${uniqueRn("dead").replace(/-/g, "")}`;
  const rn = uniqueRn("csr");
  const res = await create(A, CSE_BASE, 16, {
    "m2m:csr": {
      rn,
      cb: `${csi}/${CSE_BASE}`,
      csi,
      rr: true,
      srv: ["4"],
      // Port 1 on loopback: the connection is refused immediately, so the test does not sit
      // through a timeout.
      poa: ["http://127.0.0.1:1"],
    },
  }, { originator: csi });
  assert.equal(res.rsc, "2001", `unreachable CSE setup failed: ${res.raw.slice(0, 200)}`);
  return `${csi}/${CSE_BASE}/never-there`;
}

test("TP/oneM2M/CSE/GMG/UPD/009 — a member on an unreachable CSE is kept and the group reports memberTypeValidated false", async () => {
  // TS-0004:7.4.13.2.3: "If the ... member resources are temporarily unreachable, the receiver
  // shall set the memberTypeValidated attribute of the <group> resource to false and return the
  // result to the originator in the response of the request." Not an error, and not a reason to
  // silently shrink the group.
  const local = await localMember();
  const { res: created, sid } = await createGroup({ mt: TY_CNT, csy: ABANDON_MEMBER, mid: [local] });
  assert.equal(created.rsc, "2001");
  const unreachable = await unreachableRemoteMember();

  const res = await update(A, sid, { "m2m:grp": { mid: [local, unreachable] } });

  assert.equal(res.rsc, "2004", res.raw.slice(0, 300));
  const grp = res.body["m2m:grp"];
  assert.deepEqual(grp.mid, [local, unreachable], "the unreachable member stays in the group");
  assert.equal(grp.mtv, false, "memberTypeValidated must say the validation did not happen");
});

test("a <group> CREATE with an unreachable member is created with memberTypeValidated false", async () => {
  const local = await localMember();
  const unreachable = await unreachableRemoteMember();

  const { res } = await createGroup({ mt: TY_CNT, csy: ABANDON_MEMBER, mid: [local, unreachable] });

  assert.equal(res.rsc, "2001", res.raw.slice(0, 300));
  assert.deepEqual(res.body["m2m:grp"].mid, [local, unreachable]);
  assert.equal(res.body["m2m:grp"].mtv, false);
});
