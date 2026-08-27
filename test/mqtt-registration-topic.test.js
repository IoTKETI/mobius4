"use strict";
// TS-0010:6.4.4 Initial Registration — the registration topic pair.
//
// An Originator registering for the first time does not have an AE-ID, and the ordinary request
// topic's <originator> segment is that very ID (TS-0010:6.4.2). So the specification gives
// registration a topic pair of its own carrying a Credential-ID instead:
//
//   /oneM2M/reg_req/<originator>/<receiver>/<type>
//   /oneM2M/reg_resp/<originator>/<receiver>/<type>
//
// "Initial registration exchanges can use the communication pattern described in clauses 6.4.1 and
// 6.4.2 except that they use Topics containing a credential ID rather than an AE-ID or CSE-ID."
//
// TS-0018 has no test purpose for this — searched all five source files for the topic literals and
// for MQTT: the test purposes are binding-neutral, and TS-0019:5.1 puts the binding in the lower
// layer instead. So these assertions come from TS-0010:6.4.4 directly and carry no TP identifier
// rather than an invented one. The AE-registration behaviour they lean on is pinned by the
// TP-derived tests elsewhere; what is new here is only which topic carries it.
//
// What was actually missing, measured before the change (v4.16.2): registration over MQTT already
// worked through the ordinary /oneM2M/req topic — an <AE> CREATE with `fr` set to a made-up
// credential, to an empty string, or to nothing at all all answered 2001. Publishing the identical
// primitive to /oneM2M/reg_req produced no response whatsoever, because nothing subscribed to it.
// This was a conformance gap rather than a functional one, which is why the change is additive and
// no existing client can notice it.
//
// The topic proves nothing about who is asking. TS-0010:6.4.4 calls the segment a Credential-ID,
// a TS-0003 concept, and mobius4 has no authentication layer (BACKLOG-104 in mobius4-dev-tool).
// The last test in this file exists to keep that from being read the other way.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const amqtt = require("async-mqtt");
const { startServer } = require("./helpers/server");
const { startBroker } = require("./helpers/broker");
const mq = require("./helpers/mqtt-onem2m");

const CSE_BASE = mq.CSE_BASE;
const RECEIVER = "Mobius4"; // config.cse.cse_id with its leading '/' dropped, per TS-0010:6.4.4

let broker, srv, raw;
const inbox = [];
// <AE>s this file registers, removed in after() so a debugging run does not add to the database
// every time it is executed.
const registered = [];

before(async () => {
  broker = await startBroker();
  srv = await startServer({ mqttPort: broker.port });
  raw = await amqtt.connectAsync(`tcp://127.0.0.1:${broker.port}`);
  raw.on("message", (topic, payload) => {
    let body = null;
    try { body = JSON.parse(payload.toString()); } catch { /* kept as raw for diagnosis */ }
    inbox.push({ topic, body, raw: payload.toString() });
  });
});

after(async () => {
  for (const sid of registered) {
    await publishAndWait("req", "test-admin", { fr: "test-admin", to: sid, rqi: nextRqi(), op: 4, rvi: "3" })
      .catch(() => { /* cleanup is best effort; the database reset is the real guarantee */ });
  }
  if (raw) await raw.end();
  if (srv) await srv.stop();
  if (broker) await broker.stop();
});

// Publishes a primitive to a topic and waits for the answer that carries the same rqi. Deliberately
// bypasses test/helpers/mqtt-onem2m.js: that helper fixes its topics at connect time, and which
// topic a message travels on is the whole subject here.
async function publishAndWait(topicLiteral, credential, prim, { timeoutMs = 4000 } = {}) {
  const respLiteral = topicLiteral === "reg_req" ? "reg_resp" : "resp";
  const respTopic = `/oneM2M/${respLiteral}/${credential}/${RECEIVER}/json`;
  await raw.subscribe(respTopic);
  const from = inbox.length;

  await raw.publish(`/oneM2M/${topicLiteral}/${credential}/${RECEIVER}/json`, JSON.stringify(prim));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = inbox.slice(from).find((m) => m.body && m.body.rqi === prim.rqi);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

let seq = 0;
const nextRqi = () => `reg-${process.pid.toString(36)}-${++seq}`;

// Credentials are unique per run. An AE-ID is derived from the From parameter, so a fixed string
// registers once and answers 4117 CONFLICT on every later run against the same database -- the
// suite resets it (scripts/reset-test-db.js) but a single file run during debugging does not, and
// a test that only passes on a fresh database is the class of defect BACKLOG-100 was about. The
// ':' is kept because TS-0010:6.4.4 replaces embedded '/' with it and TS-0019:7.3's
// PX_CREDENTIAL_ID for MQTT is "admin:admin" -- a colon is the ordinary case, not an edge one.
const credential = (label) => `cred:${label}:${mq.uniqueRn("")}`;

function aeCreate(credential, over = {}) {
  return {
    fr: credential,
    to: CSE_BASE,
    rqi: nextRqi(),
    op: 1,
    ty: 2,
    rvi: "3",
    pc: { "m2m:ae": { rn: mq.uniqueRn("regae"), api: "Nreg.test", rr: true } },
    ...over,
  };
}

test("an <AE> registers over the registration topic and is answered on reg_resp", async () => {
  const cred = credential("one");
  const prim = aeCreate(cred);

  const got = await publishAndWait("reg_req", cred, prim);

  assert.ok(got, "no response arrived on the reg_resp topic within 4s");
  assert.equal(got.topic, `/oneM2M/reg_resp/${cred}/${RECEIVER}/json`,
    "the response must travel on reg_resp, mirroring the request topic (TS-0010:6.4.4)");
  assert.equal(String(got.body.rsc), "2001", `registration failed: ${got.raw.slice(0, 200)}`);
  assert.ok(got.body.pc["m2m:ae"].aei, "the response should carry the assigned AE-ID");
  registered.push(`${CSE_BASE}/${prim.pc["m2m:ae"].rn}`);
});

test("a <remoteCSE> registration is accepted on the same topic", async () => {
  // TS-0010:6.4.4 and 6.3.3 both name the AE-ID *and* the CSE-ID as what an Originator may not yet
  // know, so CSE registration belongs on this topic as much as AE registration does. The create
  // itself is expected to be refused for want of a registrar relationship rather than for the
  // topic -- what is asserted is that it reaches the request handling at all instead of being
  // turned away by the guard, which is what any RSC other than 4005 demonstrates.
  const cred = credential("cse");
  const prim = {
    fr: "/reg-remote", to: CSE_BASE, rqi: nextRqi(), op: 1, ty: 16, rvi: "3",
    pc: { "m2m:csr": { rn: mq.uniqueRn("regcsr"), cst: 1, csi: "/reg-remote", rr: true, poa: ["http://127.0.0.1:1/"] } },
  };

  const got = await publishAndWait("reg_req", cred, prim);

  assert.ok(got, "no response arrived on the reg_resp topic within 4s");
  assert.notEqual(String(got.body.rsc), "4005",
    `<remoteCSE> is a registration type and must pass the topic guard: ${got.raw.slice(0, 200)}`);
});

test("a non-registration operation on the registration topic is refused with 4005", async () => {
  // The design decision this pins: the topic serves registration only. Nothing in TS-0010:6.4.4
  // demands the refusal, and accepting everything would be less code -- but then the topic is just
  // an alias for /oneM2M/req, clients come to depend on that, and narrowing it later breaks them.
  const cred = credential("two");
  const prim = { fr: cred, to: CSE_BASE, rqi: nextRqi(), op: 2, rvi: "3" };

  const got = await publishAndWait("reg_req", cred, prim);

  assert.ok(got, "a refusal must be sent, not silence — silence is what this change exists to end");
  assert.equal(String(got.body.rsc), "4005", `expected OPERATION_NOT_ALLOWED: ${got.raw.slice(0, 200)}`);
});

test("creating a <container> on the registration topic is refused with 4005", async () => {
  // The other half of the guard: op is right, ty is not.
  const cred = credential("three");
  const prim = {
    fr: cred, to: CSE_BASE, rqi: nextRqi(), op: 1, ty: 3, rvi: "3",
    pc: { "m2m:cnt": { rn: mq.uniqueRn("regcnt") } },
  };

  const got = await publishAndWait("reg_req", cred, prim);

  assert.ok(got, "a refusal must be sent, not silence");
  assert.equal(String(got.body.rsc), "4005", `expected OPERATION_NOT_ALLOWED: ${got.raw.slice(0, 200)}`);
});

test("the ordinary request topic still serves every operation", async () => {
  // The guard must not have leaked onto /oneM2M/req. A RETRIEVE of the <CSEBase> is refused on the
  // registration topic by the test above and must be answered here.
  const prim = { fr: "test-admin", to: CSE_BASE, rqi: nextRqi(), op: 2, rvi: "3" };

  const got = await publishAndWait("req", "test-admin", prim);

  assert.ok(got, "no response on the ordinary response topic");
  assert.equal(got.topic, `/oneM2M/resp/test-admin/${RECEIVER}/json`);
  assert.equal(String(got.body.rsc), "2000", `expected OK: ${got.raw.slice(0, 200)}`);
});

test("an unserved serialization is refused rather than dropped", async () => {
  // TS-0010:6.4.2 and 6.4.4 end both topics with a <type> segment of "xml", "json" or "cbor"
  // (6.5.4). Only json is implemented. Before v4.17.1 the other two were not subscribed at all,
  // so a request using either vanished — measured 2026-08-26, no response of any kind, which a
  // client cannot tell apart from a dead CSE. They are subscribed now purely so the answer exists.
  //
  // The refusal is published as json on a json response topic, because emitting xml or cbor is
  // precisely what this CSE cannot do. A client that cannot parse it is no worse off than with
  // the silence, and it now has a response at all. BACKLOG-121 tracks implementing them properly.
  for (const type of ["xml", "cbor"]) {
    const cred = credential(`ser-${type}`);
    const respTopic = `/oneM2M/resp/${cred}/${RECEIVER}/json`;
    await raw.subscribe(respTopic);
    const from = inbox.length;

    // Deliberately not valid JSON: an xml or cbor payload is not, and the refusal has to come
    // before parsing or the request dies on the parse instead.
    await raw.publish(`/oneM2M/req/${cred}/${RECEIVER}/${type}`, "<not-json/>");

    const deadline = Date.now() + 4000;
    let hit = null;
    while (Date.now() < deadline && !hit) {
      hit = inbox.slice(from).find((m) => m.topic === respTopic);
      if (!hit) await new Promise((r) => setTimeout(r, 25));
    }

    assert.ok(hit, `${type}: no response — silence is what this change exists to end`);
    assert.equal(String(hit.body.rsc), "5001",
      `${type}: expected NOT_IMPLEMENTED: ${hit.raw.slice(0, 200)}`);
    assert.match(hit.body.pc["m2m:dbg"], /json/, "the message should say what to use instead");
  }
});

test("the registration topic authenticates nothing — any credential string reaches it", async () => {
  // Not a feature. TS-0010:6.4.4 names the segment a Credential-ID, which in TS-0003 is something
  // a security framework establishes; mobius4 has no authentication layer, so the segment is an
  // opaque string used only to address the response.
  //
  // This is asserted rather than left as a comment because the shape of the topic invites the
  // opposite reading, and this repository has been here before: the HTTPS listener set requestCert
  // until v4.7.0 and nothing ever read the certificate, so it looked like mutual authentication to
  // everyone who found it. If authentication does arrive (BACKLOG-104), this test should fail and
  // be replaced by one that states what the credential now proves.
  // Well-formed as a From parameter -- that much is checked, and a string with extra ':' segments
  // is refused 4000, which is a syntax rule (TS-0001:7.2) rather than an identity one. What is not
  // checked is whether the credential belongs to anybody: this one was invented one line above.
  const cred = credential("invented");
  const prim = aeCreate(cred);

  const got = await publishAndWait("reg_req", cred, prim);

  assert.ok(got, "no response arrived");
  registered.push(`${CSE_BASE}/${prim.pc["m2m:ae"].rn}`);
  assert.equal(String(got.body.rsc), "2001",
    "an arbitrary credential is accepted today; if this changed, authentication landed and the " +
    "comment above needs rewriting rather than this assertion being loosened");
});
