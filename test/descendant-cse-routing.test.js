"use strict";
// descendantCSEs (dcse) storage and routing. TS-0018 has no test purpose for this -- it is not
// one of the TP/oneM2M/CSE/REG/* identifiers -- so these tests are derived from the core
// specification instead:
//
//   TS-0001:9.6.4   -- descendantCSEs is 0..1(L), RW, "a list of CSE-IDs of descendant CSEs of
//                      the registering/registree CSE", set by the registree at registration and
//                      updated "whenever a Remote CSE registers or de-registers".
//   TS-0004:7.4.4.1 -- descendantCSEs (dcse) is O (optional) on both Create and Update of
//                      <remoteCSE> (table 7.4.4.1-1).
//   TS-0004:7.3.2.6 -- the receiving CSE "checks each of its <remoteCSE> resources to find
//                      whether the CSE-ID in the To parameter of the primitive matches either
//                      the CSE-ID attribute or one of the CSE-IDs in the descendantCSEs
//                      attribute of the <remoteCSE> resource. If a match is found, the CSE
//                      shall retarget the request to the pointOfAccess of the matching
//                      <remoteCSE> resource ... If a match is not found and the CSE is the
//                      IN-CSE the CSE shall not forward the request, and it shall respond with
//                      an error using Response Status Code 'NOT_FOUND'."
//
// Reported scenario: ACME, registering with mobius4 as an MN-CSE, sends the standard dcse
// attribute on its <remoteCSE> (empty when it has no descendants yet, populated once one
// registers under it). Before this feature mobius4 refused dcse outright with 4000 "dcse is not
// allowed" (S1), and even granting the attribute, routing only ever matched a <remoteCSE>'s own
// csi -- a request aimed at a grandchild CSE (registered with the MN, not with mobius4) came
// back 4004 "CSR resource not found" (S5), because nothing ever looked inside dcse.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { CSE_BASE, ADMIN, create, retrieve, update, uniqueRn } = require("./helpers/onem2m");
const { startServer } = require("./helpers/server");
// Read directly rather than assume "//localhost" (config/default.json's value): this process
// undergoes the same node-config merge the spawned server does, and a gitignored
// config/local.json on a given machine can override sp_id (measured here: "//mydomain.io").
// Hardcoding the default would make this test fail on any machine with such a local override.
const SP_ID = require("config").get("cse.sp_id");

// A stand-in CSE, copied from test/forwarding.test.js: records what it received and answers
// with the status it was told.
async function startFakeCse({ rsc = "2000", status = 200, body = { "m2m:ae": { rn: "ae1" } } } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => { received[received.length - 1].body = raw; });
    received.push({ method: req.method, url: req.url, origin: req.headers["x-m2m-origin"],
                    ri: req.headers["x-m2m-ri"], headers: req.headers });
    res.setHeader("X-M2M-RSC", rsc);
    res.setHeader("X-M2M-RI", req.headers["x-m2m-ri"] || "");
    res.setHeader("X-M2M-RVI", "3");
    res.setHeader("Content-Type", "application/json");
    res.writeHead(status);
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    received,
    stop: () => new Promise((r) => server.close(r)),
  };
}

let srv;

before(async () => {
  srv = await startServer();
});

after(async () => {
  if (srv) await srv.stop();
});

function uid(prefix) {
  return uniqueRn(prefix).replace(/-/g, "");
}

// A <remoteCSE> body with the mandatory attributes only, plus whatever this test needs on top.
// Mirrors the exact shape ACME sends (rn, cb, rr, srv, csi, poa, dcse).
function csrBody(csi, over = {}) {
  return {
    "m2m:csr": {
      rn: uniqueRn("csr"),
      cb: `${csi}/${CSE_BASE}`,
      rr: true,
      srv: ["3"],
      csi,
      ...over,
    },
  };
}

async function registerCse(csi, over = {}) {
  const body = csrBody(csi, over);
  const res = await create(srv.baseUrl, CSE_BASE, 16, body, { originator: csi });
  return { sid: `${CSE_BASE}/${body["m2m:csr"].rn}`, csi, res };
}

// ---------------------------------------------------------------------------
// 1. CREATE with an empty dcse (S1 reproduction, ACME's actual shape)
// ---------------------------------------------------------------------------

test("CREATE <remoteCSE> with dcse: [] is accepted (2001), not rejected as 4000 (S1)", async () => {
  const u = uid("s1");
  const { sid, res } = await registerCse(`/empty-${u}`, { dcse: [] });

  assert.equal(res.rsc, "2001", res.raw.slice(0, 300));
  // The XSD minLength-1 list is normalized to "no descendants" (null), not stored or echoed as [].
  assert.ok(!("dcse" in res.body["m2m:csr"]), "an empty dcse must not be echoed back");

  const got = (await retrieve(srv.baseUrl, sid, { originator: `/empty-${u}` })).body["m2m:csr"];
  assert.ok(!("dcse" in got), "an empty dcse must not be stored as an empty list either");
});

// ---------------------------------------------------------------------------
// 2. CREATE with a populated dcse, round-tripped
// ---------------------------------------------------------------------------

test("CREATE <remoteCSE> with dcse: [\"/id-site-<u>\"] is accepted (2001) and kept as-is", async () => {
  const u = uid("s2");
  const descendant = `/id-site-${u}`;
  const { sid, res, csi } = await registerCse(`/mn-${u}`, { dcse: [descendant] });

  assert.equal(res.rsc, "2001", res.raw.slice(0, 300));
  assert.deepEqual(res.body["m2m:csr"].dcse, [descendant]);

  const got = (await retrieve(srv.baseUrl, sid, { originator: csi })).body["m2m:csr"];
  assert.deepEqual(got.dcse, [descendant]);
});

// ---------------------------------------------------------------------------
// 3. IN routing to a descendant CSE that never registered with mobius4 itself (S5 reproduction)
// ---------------------------------------------------------------------------

test("GET to a descendant CSE listed only in dcse is retargeted to the registree's poa (S5)", async (t) => {
  const u = uid("s3");
  const fake = await startFakeCse({ rsc: "2000", body: { "m2m:ae": { rn: "ae1" } } });
  t.after(() => fake.stop());

  const descendant = `/id-site-${u}`;
  const { res: regRes } = await registerCse(`/mn-${u}`, { poa: [fake.url], dcse: [descendant] });
  assert.equal(regRes.rsc, "2001", regRes.raw.slice(0, 300));

  const testRi = `desc-route-${u}`;
  const res = await retrieve(srv.baseUrl, `~${descendant}/cse-site/ae1`, {
    originator: ADMIN,
    headers: { "X-M2M-RI": testRi },
  });

  assert.equal(fake.received.length, 1, "the fake CSE standing in for the registree must have been dialled");
  assert.equal(fake.received[0].ri, testRi, "the Originator's own Request Identifier must be forwarded unchanged");
  assert.ok(
    fake.received[0].url.endsWith(`/~${descendant}/cse-site/ae1`),
    `expected the forwarded To to end with /~${descendant}/cse-site/ae1, got ${fake.received[0].url}`
  );
  assert.equal(res.rsc, "2000", "the response status must be whatever the fake CSE answered");
});

// ---------------------------------------------------------------------------
// 4. UPDATE replaces dcse wholesale: the old target stops resolving, the new one works
// ---------------------------------------------------------------------------

test("UPDATE of dcse retargets routing: old descendant 4004s, new descendant is forwarded", async (t) => {
  const u = uid("s4");
  const fake = await startFakeCse({ rsc: "2000" });
  t.after(() => fake.stop());

  const oldDescendant = `/id-site-${u}`;
  const newDescendant = `/id-other-${u}`;
  const { sid, csi, res: regRes } = await registerCse(`/mn-${u}`, { poa: [fake.url], dcse: [oldDescendant] });
  assert.equal(regRes.rsc, "2001", regRes.raw.slice(0, 300));

  const updRes = await update(srv.baseUrl, sid, { "m2m:csr": { dcse: [newDescendant] } }, { originator: csi });
  if (updRes.rsc !== "2004") {
    // Per the controller's instruction: if access control refuses this UPDATE, report it rather
    // than loosening access control to make the test pass.
    assert.fail(
      `UPDATE of dcse by the registree (originator=${csi}) was refused: rsc=${updRes.rsc} body=${updRes.raw.slice(0, 300)}`
    );
  }

  const oldTarget = await retrieve(srv.baseUrl, `~${oldDescendant}/x`, { originator: ADMIN });
  assert.equal(oldTarget.rsc, "4004", "the old descendant must no longer resolve once dcse no longer lists it");

  const newTarget = await retrieve(srv.baseUrl, `~${newDescendant}/x`, { originator: ADMIN });
  assert.equal(newTarget.rsc, "2000", "the new descendant must be forwarded");
  assert.equal(fake.received.length, 1, "only the new-descendant request should have reached the fake CSE");
});

// ---------------------------------------------------------------------------
// 5. UPDATE with dcse: null clears it: no dcse on retrieve, old target 4004s
// ---------------------------------------------------------------------------

test("UPDATE of dcse: null clears descendants: not retrieved, old target 4004s", async (t) => {
  const u = uid("s5");
  const fake = await startFakeCse({ rsc: "2000" });
  t.after(() => fake.stop());

  const descendant = `/id-site-${u}`;
  const { sid, csi, res: regRes } = await registerCse(`/mn-${u}`, { poa: [fake.url], dcse: [descendant] });
  assert.equal(regRes.rsc, "2001", regRes.raw.slice(0, 300));

  const updRes = await update(srv.baseUrl, sid, { "m2m:csr": { dcse: null } }, { originator: csi });
  if (updRes.rsc !== "2004") {
    assert.fail(
      `UPDATE of dcse: null by the registree (originator=${csi}) was refused: rsc=${updRes.rsc} body=${updRes.raw.slice(0, 300)}`
    );
  }

  const got = (await retrieve(srv.baseUrl, sid, { originator: csi })).body["m2m:csr"];
  assert.ok(!("dcse" in got), "dcse must be gone after being cleared with null");

  const target = await retrieve(srv.baseUrl, `~${descendant}/x`, { originator: ADMIN });
  assert.equal(target.rsc, "4004", "the cleared descendant must no longer resolve");
});

// ---------------------------------------------------------------------------
// 6. Absolute-form dcse entries are matched too
// ---------------------------------------------------------------------------

test("a dcse entry written in Absolute form (sp_id + CSE-ID) is still matched by SP-relative routing", async (t) => {
  const u = uid("s6");
  const fake = await startFakeCse({ rsc: "2000" });
  t.after(() => fake.stop());

  // The Absolute form of a CSE-ID is sp_id + CSE-ID; SP_ID is read above from this process's
  // own config, not assumed, so this test is correct whatever sp_id this machine is actually
  // configured with.
  const descendant = `/id-abs-${u}`;
  const absoluteDescendant = `${SP_ID}${descendant}`;
  const { res: regRes } = await registerCse(`/mn-${u}`, { poa: [fake.url], dcse: [absoluteDescendant] });
  assert.equal(regRes.rsc, "2001", regRes.raw.slice(0, 300));

  const res = await retrieve(srv.baseUrl, `~${descendant}/x`, { originator: ADMIN });

  assert.equal(res.rsc, "2000", "an Absolute-form dcse entry must still answer an SP-relative To");
  assert.equal(fake.received.length, 1);
});

// ---------------------------------------------------------------------------
// 7. Regression: a directly registered CSE (csi match) still routes as before
// ---------------------------------------------------------------------------

test("a directly registered <remoteCSE> (csi match) still routes without dcse (regression)", async (t) => {
  const u = uid("s7");
  const fake = await startFakeCse({ rsc: "2000" });
  t.after(() => fake.stop());

  const directCsi = `/direct-${u}`;
  const { res: regRes } = await registerCse(directCsi, { poa: [fake.url] });
  assert.equal(regRes.rsc, "2001", regRes.raw.slice(0, 300));

  const res = await retrieve(srv.baseUrl, `~${directCsi}/x`, { originator: ADMIN });

  assert.equal(res.rsc, "2000");
  assert.equal(fake.received.length, 1);
});

// ---------------------------------------------------------------------------
// 8. A target found neither by csi nor by any dcse is 4004, as before
// ---------------------------------------------------------------------------

test("a target matching no <remoteCSE>'s csi or dcse is 4004 CSR resource not found", async () => {
  const u = uid("s8");

  const res = await retrieve(srv.baseUrl, `~/nowhere-${u}/x`, { originator: ADMIN });

  assert.equal(res.rsc, "4004");
  assert.equal(res.body?.["m2m:dbg"], "CSR resource not found");
});
