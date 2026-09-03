"use strict";
// Request forwarding to a <remoteCSE>, and the two silent wrong answers it used to give.
//
// 1. The remote CSE's response status was discarded. The HTTP branch read x-m2m-rsc from the
//    response into resp_prim and then fell through to an unconditional `resp_prim.rsc = OK` at the
//    end of the function, so a forwarded 4004 reached the Originator as 2000 — with the error
//    payload still attached, which is how it stayed unnoticed.
//
// 2. Only poa[0] was tried. pointOfAccess is a list because a CSE may be reachable more than one
//    way; a <remoteCSE> advertising three was unreachable as soon as the first stopped answering.
//    An mqtt: poa was worse: the branch was empty, so a request that was never sent anywhere was
//    reported as OK.
//
// TS-0004:6.6.3.6 gives 5103 TARGET_NOT_REACHABLE for the case where no access point answers.
//
// These are unit tests over request_forwarding rather than end-to-end registrations: what is
// under test is which poa is dialled and what comes back, and a real <remoteCSE> registration
// would add a second CSE to the fixture without exercising any of that.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// A stand-in CSE. Each instance records what it received and answers with the status it was told.
async function startFakeCse({ rsc = "2000", status = 200, body = { "m2m:cnt": { rn: "x" } } } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
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

// A port nothing is listening on, for the transport-failure cases.
async function deadUrl() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${s.address().port}`;
  await new Promise((r) => s.close(r));
  return url;
}

let reqPrim, enums;

before(() => {
  process.env.NODE_ENV = "test";
  process.env.NODE_CONFIG = JSON.stringify({
    cse: { admin: "Stest0000001" },
    logging: { level: "error", file: { enabled: false } },
    mqtt: { enabled: false },
  });
  reqPrim = require("../cse/reqPrim");
  enums = require("../config/enums");
});

after(() => {});

// request_forwarding(req_prim, shortest_to) reads the <remoteCSE> from the database, so these
// tests drive the poa loop directly through the exported helper the handler uses.
const { forward_to_poa } = reqPrim;

test("the remote CSE's status is returned, not replaced with OK", async (t) => {
  if (!forward_to_poa) return t.skip("forward_to_poa is not exported");

  const remote = await startFakeCse({ rsc: "4004", status: 404, body: { "m2m:dbg": "no such thing" } });
  t.after(() => remote.stop());

  const resp = {};
  await forward_to_poa([remote.url], { op: 2, fr: "Sabc", rqi: "r1", rvi: "3" }, "Mobius/x", resp);

  // A number, not the "4004" string the header carried: responseStatusCode is xs:integer
  // (TS-0004 CDT-enumerationTypes.xsd), and passing the header through verbatim put a quoted
  // status into group fanout aggregations next to numeric local ones.
  assert.equal(resp.rsc, 4004, "a forwarded 4004 must not arrive as 2000");
  assert.deepEqual(resp.pc, { "m2m:dbg": "no such thing" });
});

test("a dead poa is skipped and the next one is used", async (t) => {
  if (!forward_to_poa) return t.skip("forward_to_poa is not exported");

  const dead = await deadUrl();
  const alive = await startFakeCse({ rsc: "2000" });
  t.after(() => alive.stop());

  const resp = {};
  await forward_to_poa([dead, alive.url], { op: 2, fr: "Sabc", rqi: "r2", rvi: "3" }, "Mobius/x", resp);

  assert.equal(resp.rsc, 2000);
  assert.equal(alive.received.length, 1, "the second access point was actually dialled");
});

test("when no poa answers, the status is 5103 TARGET_NOT_REACHABLE", async (t) => {
  if (!forward_to_poa) return t.skip("forward_to_poa is not exported");

  const dead1 = await deadUrl();
  const dead2 = await deadUrl();

  const resp = {};
  await forward_to_poa([dead1, dead2], { op: 2, fr: "Sabc", rqi: "r3", rvi: "3" }, "Mobius/x", resp);

  assert.equal(resp.rsc, enums.rsc_str["TARGET_NOT_REACHABLE"]);
  assert.match(resp.pc["m2m:dbg"], /no pointOfAccess answered/);
});

test("an mqtt poa is refused rather than reported as OK", async (t) => {
  if (!forward_to_poa) return t.skip("forward_to_poa is not exported");

  const resp = {};
  await forward_to_poa(["mqtt://broker.example:1883"], { op: 2, fr: "Sabc", rqi: "r4", rvi: "3" }, "Mobius/x", resp);

  assert.notEqual(resp.rsc, enums.rsc_str["OK"], "a request that went nowhere is not a success");
  assert.equal(resp.rsc, enums.rsc_str["TARGET_NOT_REACHABLE"]);
});

// ── the To parameter and the Request Identifier ───────────────────────────────────────────────
//
// TS-0004:7.3.2.6 enumerates what a forwarding CSE converts: From into SP-relative or Absolute
// format, M2M Service User across SP domains, and the removal of Release Version Indicator and
// Vendor Information for a Release 1 entity. To is not among them, and neither is the Request
// Identifier.
//
// Both were being modified. To was rewritten into CSE-relative form by cutting the target CSE-ID
// out of it, and the Request Identifier was prefixed with "forwarding_" on the way out and then
// read back off the remote CSE's answer on the way in -- so the Originator got a Request
// Identifier it had never sent.

const { to_path_component } = reqPrim;

test("To maps onto the path component exactly as TS-0009 table 6.2.2.1-1 says", () => {
  // The rows of that table, verbatim. This is the inverse of what bindings/http.js does on the way
  // in, which is what lets the parameter be forwarded without being rewritten.
  assert.equal(to_path_component("CSEBase/ae12/cont27/contInst696"), "/CSEBase/ae12/cont27/contInst696");
  assert.equal(to_path_component("cin00856"), "/cin00856");
  assert.equal(to_path_component("/CSE178/CSEBase/ae12/cont27/contInst696"), "/~/CSE178/CSEBase/ae12/cont27/contInst696");
  assert.equal(to_path_component("/CSE178/cin00856"), "/~/CSE178/cin00856");
  assert.equal(to_path_component("//mym2msp.org/CSE178/CSEBase/ae12/cont27/contInst696"), "/_/mym2msp.org/CSE178/CSEBase/ae12/cont27/contInst696");
  assert.equal(to_path_component("//mym2msp.org/CSE178/cin00856"), "/_/mym2msp.org/CSE178/cin00856");
});

test("the To parameter is forwarded as it stands, CSE-ID and all", async (t) => {
  if (!forward_to_poa) return t.skip("forward_to_poa is not exported");
  const remote = await startFakeCse();
  t.after(() => remote.stop());

  await forward_to_poa([remote.url], { op: 2, fr: "Sabc", rqi: "r1", rvi: "3" },
    "/reg-b/Mobius/thing", {});

  // Not "/Mobius/thing". The next CSE routes a further hop by the CSE-ID in the To parameter
  // matching its descendantCSEs (TS-0004:7.3.2.6); with the CSE-ID cut out there is nothing left
  // to route on.
  assert.equal(remote.received[0].url, "/~/reg-b/Mobius/thing");
});

test("a To that is only a CSE-ID does not become the string 'undefined'", async (t) => {
  if (!forward_to_poa) return t.skip("forward_to_poa is not exported");
  const remote = await startFakeCse();
  t.after(() => remote.stop());

  // Retrieving another CSE's <CSEBase>. The old code cut on `${cseId}/` and took what followed,
  // which for a To with no path was nothing at all -- the request went to poa + "/undefined".
  await forward_to_poa([remote.url], { op: 2, fr: "Sabc", rqi: "r1", rvi: "3" }, "/reg-b", {});
  assert.equal(remote.received[0].url, "/~/reg-b");
});

test("a path that repeats the CSE-ID is not truncated", async (t) => {
  if (!forward_to_poa) return t.skip("forward_to_poa is not exported");
  const remote = await startFakeCse();
  t.after(() => remote.stop());

  // The old cut was a string match, so /reg-b/a/reg-b/b lost everything after the second
  // occurrence and the request went to a different resource than the one asked for -- silently,
  // with a 2000.
  await forward_to_poa([remote.url], { op: 2, fr: "Sabc", rqi: "r1", rvi: "3" },
    "/reg-b/a/reg-b/b", {});
  assert.equal(remote.received[0].url, "/~/reg-b/a/reg-b/b");
});

test("the Originator's Request Identifier is what goes out and what comes back", async (t) => {
  if (!forward_to_poa) return t.skip("forward_to_poa is not exported");
  const remote = await startFakeCse();
  t.after(() => remote.stop());

  // The response primitive's rqi is set by request_forwarding before the poa loop; this stands in
  // for it, and the point of the test is that nothing in the loop overwrites it.
  const resp = { rqi: "client-42" };
  await forward_to_poa([remote.url], { op: 2, fr: "Sabc", rqi: "client-42", rvi: "3" },
    "/reg-b/Mobius/x", resp);

  assert.equal(remote.received[0].ri, "client-42",
    "the hop carries the Originator's Request Identifier, not a derived one");
  assert.equal(resp.rqi, "client-42",
    "and the answer carries it back -- TS-0001:10.2.5.19 correlates request to response by it");
});

test("an error status from the remote CSE does not take the Request Identifier with it", async (t) => {
  if (!forward_to_poa) return t.skip("forward_to_poa is not exported");
  // The error path read x-m2m-ri off the response too, so the rqi was lost on failures as well.
  const remote = await startFakeCse({ rsc: "4004", status: 404, body: { "m2m:dbg": "nope" } });
  t.after(() => remote.stop());

  const resp = { rqi: "client-43" };
  await forward_to_poa([remote.url], { op: 2, fr: "Sabc", rqi: "client-43", rvi: "3" },
    "/reg-b/Mobius/x", resp);

  assert.equal(resp.rsc, 4004);
  assert.equal(resp.rqi, "client-43");
});
