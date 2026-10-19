"use strict";
// What Mobius4 does as an MN-CSE towards its registrar: it reports the CSEs registered below it
// in descendantCSEs, and it retargets upward what it cannot route itself.
//
// TS-0018 has no test purpose for this. TP/oneM2M/CSE/DMR/001 covers the registrar itself being
// the target, which a direct csi match already handles; nothing tests an MN-CSE keeping its
// registrar's descendantCSEs current or deciding which way to retarget. These tests are derived
// from the core specification instead:
//
//   TS-0004:7.3.2.6 -- "If a match is not found, and the CSE received the request from an AE or
//                      a descendant CSE, and the CSE is not the IN-CSE, then it shall retarget
//                      the request to its Registrar CSE." / "If a match is not found and the CSE
//                      is not the IN-CSE and the CSE receives the request from its registrar CSE
//                      the CSE shall not forward the request, and it shall respond with ...
//                      'NOT_FOUND'."
//   TS-0004:7.4.4.2.1/.3/.4 (Recv-6.5) -- a CSE that accepts a registration, an update of
//                      descendantCSEs or a de-registration, and is itself registered, updates its
//                      own <remoteCSE>.descendantCSEs on its registrar.
//   TS-0001:9.6.4   -- descendantCSEs is set by the registree at registration, and not on the
//                      <remoteCSE> that represents the registrar.
//
// The fixture is test/helpers/two-cse.js: A is the IN-CSE (/reg-a), B an MN-CSE (/reg-b)
// registered with A. F and G are fake CSEs -- plain HTTP servers that record what reaches them --
// registered as <remoteCSE> with B and with A respectively.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { CSE_BASE, ADMIN, create, retrieve, remove, uniqueRn } = require("./helpers/onem2m");
const { startTwoCSEs } = require("./helpers/two-cse");

// Copied from test/forwarding.test.js: records what it received and answers with the status it
// was told.
async function startFakeCse({ rsc = "2000", status = 200, body = { "m2m:cnt": { rn: "x" } } } = {}) {
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

let env;
const fakes = [];

before(async () => {
  env = await startTwoCSEs();
});

after(async () => {
  for (const f of fakes) await f.stop();
  if (env) await env.stop();
});

async function fake() {
  const f = await startFakeCse();
  fakes.push(f);
  return f;
}

function uid(prefix) {
  return uniqueRn(prefix).replace(/-/g, "");
}

// Registers a CSE as a <remoteCSE> on `baseUrl`, the way a real registree would: originator is
// its own CSE-ID, the registrar's <CSEBase> is the target.
async function registerCse(baseUrl, csi, poa) {
  const rn = uniqueRn("csr");
  const res = await create(baseUrl, CSE_BASE, 16,
    { "m2m:csr": { rn, cb: `${csi}/${CSE_BASE}`, rr: true, srv: ["3"], csi, poa: [poa] } },
    { originator: csi });
  assert.equal(res.rsc, "2001", `registering ${csi}: ${res.raw.slice(0, 300)}`);
  return `${CSE_BASE}/${rn}`;
}

// B's <remoteCSE> on A, read as B: it is visible to its creator only (see two-cse.js).
async function dcseOfBOnA() {
  const res = await retrieve(env.a.baseUrl, env.remoteCseSid, { originator: env.b.cseId });
  assert.equal(res.rsc, "2000", res.raw.slice(0, 300));
  return res.body["m2m:csr"].dcse || null;
}

// The report is asynchronous: B answers its client first and tells A afterwards. Poll A until
// the condition holds or the deadline passes, and say what A last held if it never does.
async function waitForDcse(predicate, what) {
  const deadline = Date.now() + 10000;
  let last;
  for (;;) {
    last = await dcseOfBOnA();
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      assert.fail(`A's <remoteCSE> for B never ${what}; last dcse = ${JSON.stringify(last)}\n` +
        `--- B output ---\n${env.b.diagnostics()}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// State shared by the first two tests: F, registered with B.
let F;

test("a CSE registering with the MN-CSE appears in the registrar's descendantCSEs for it", async () => {
  const f = await fake();
  F = { fake: f, csi: `/f-${uid("f")}` };
  F.sid = await registerCse(env.b.baseUrl, F.csi, f.url);

  const dcse = await waitForDcse((d) => Array.isArray(d) && d.includes(F.csi), `listed ${F.csi}`);
  assert.ok(!dcse.includes(env.a.cseId), "the registrar itself must not be listed as a descendant");
});

test("a request to a grandchild CSE goes IN -> MN -> grandchild", async () => {
  assert.ok(F, "depends on the previous test registering F with B");
  const before = F.fake.received.length;

  const res = await retrieve(env.a.baseUrl, `~${F.csi}/x`, { originator: ADMIN });

  assert.equal(res.rsc, "2000", res.raw.slice(0, 300));
  assert.equal(F.fake.received.length, before + 1, "F must have been dialled");
  const got = F.fake.received[F.fake.received.length - 1];
  assert.ok(got.url.endsWith(`/~${F.csi}/x`), `forwarded To kept intact, got ${got.url}`);
});

test("de-registering a CSE from the MN-CSE removes it from the registrar's descendantCSEs", async () => {
  const f = await fake();
  const csi = `/f-${uid("gone")}`;
  const sid = await registerCse(env.b.baseUrl, csi, f.url);
  await waitForDcse((d) => Array.isArray(d) && d.includes(csi), `listed ${csi}`);

  const del = await remove(env.b.baseUrl, sid, { originator: csi });
  assert.equal(del.rsc, "2002", del.raw.slice(0, 300));

  await waitForDcse((d) => !(Array.isArray(d) && d.includes(csi)), `dropped ${csi}`);
});

// State shared by the last two tests: G, registered directly with A (not with B).
let G;

test("a request from an AE on the MN-CSE to a CSE it does not know is retargeted to the registrar", async () => {
  const g = await fake();
  G = { fake: g, csi: `/g-${uid("g")}` };
  await registerCse(env.a.baseUrl, G.csi, g.url);

  const ae = await create(env.b.baseUrl, CSE_BASE, 2,
    { "m2m:ae": { rn: uniqueRn("ae"), api: "Nmn.test", rr: true, srv: ["3"] } },
    { originator: "" });
  assert.equal(ae.rsc, "2001", ae.raw.slice(0, 300));
  const aei = ae.body["m2m:ae"].aei;

  const res = await retrieve(env.b.baseUrl, `~${G.csi}/x`, { originator: aei });

  assert.equal(res.rsc, "2000", res.raw.slice(0, 300));
  assert.equal(g.received.length, 1, "G must have been reached through A");
  assert.ok(g.received[0].url.endsWith(`/~${G.csi}/x`), `forwarded To kept intact, got ${g.received[0].url}`);
  // B made the AE-ID SP-relative before passing it up (TS-0004:7.3.2.6), which is also what A
  // and G see as the Originator.
  const expectedFrom = aei.startsWith("/") ? aei : `${env.b.cseId}/${aei}`;
  assert.equal(g.received[0].origin, expectedFrom);
});

test("a request that came down from the registrar is not sent back up: 4004", async () => {
  assert.ok(G, "depends on the previous test registering G with A");
  const before = G.fake.received.length;

  // G does exist -- on A. If B wrongly retargeted a request from above, it would go back to A
  // and reach G, so G staying silent is what shows B did not send it back.
  const res = await retrieve(env.b.baseUrl, `~${G.csi}/x`, { originator: `${env.a.cseId}/Cx` });

  assert.equal(res.rsc, "4004", res.raw.slice(0, 300));
  assert.equal(G.fake.received.length, before, "the request must not have been sent back up");

  // And a target known nowhere, as the plain case.
  const nowhere = await retrieve(env.b.baseUrl, `~/nowhere-${uid("n")}/x`, { originator: `${env.a.cseId}/Cx` });
  assert.equal(nowhere.rsc, "4004", nowhere.raw.slice(0, 300));
});

test("collect_descendants: registrar left out, dcse flattened, duplicates dropped, empty is null", () => {
  const { collect_descendants } = require("../cse/descendants");
  const registrar = "/in";

  assert.equal(collect_descendants([], registrar), null);
  assert.equal(collect_descendants([{ csi: registrar, dcse: null }], registrar), null,
    "the registrar's <remoteCSE> alone gives no descendants");

  const rows = [
    { csi: registrar, dcse: ["/should-not-appear"] },
    { csi: "/mn1", dcse: ["/asn1", "/asn2"] },
    { csi: "/mn2", dcse: null },
    { csi: "/asn1", dcse: ["/mn2"] },
  ];
  assert.deepEqual(collect_descendants(rows, registrar), ["/mn1", "/asn1", "/asn2", "/mn2"]);
});
