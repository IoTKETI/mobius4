"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startBroker } = require("./helpers/broker");
const { startServer } = require("./helpers/server");
const mq = require("./helpers/mqtt-onem2m");
const { create: httpCreate, createRoot } = require("./helpers/onem2m");

// Note the type of rsc differs by binding: over MQTT the response primitive is JSON-serialized
// straight from config/enums.js, so rsc is a JS number (2000). Over HTTP (see protocol.test.js)
// it comes from the X-M2M-RSC header, so it is the string "2000". Every assertion below compares
// against a number for that reason.

let broker, srv, client, root;

before(async () => {
  broker = await startBroker();
  srv = await startServer({ mqttPort: broker.port });
  client = await mq.connect(broker.port);
  root = await createRoot(srv.baseUrl, "mqtt");
});

after(async () => {
  // Reverse order: test root first (over HTTP, while the server is still up), then the MQTT
  // client, then the server, then the broker. Stopping the broker while mobius4 is still
  // connected to it produces noisy reconnect logging and slows the run down.
  if (root) await root.remove();
  if (client) await client.end();
  if (srv) await srv.stop();
  if (broker) await broker.stop();
});

test("a request published to the spec'd request topic is answered on the spec'd response topic", async () => {
  // client connects as the default originator (ADMIN, "SM"); toTopicId("SM") is "SM" (it has
  // no embedded '/' to turn into ':'), so these are exactly the TS-0010 topics for this CSE.
  assert.equal(client.reqTopic, "/oneM2M/req/SM/Mobius4/json");
  assert.equal(client.respTopic, "/oneM2M/resp/SM/Mobius4/json");

  const res = await client.retrieve(mq.CSE_BASE);
  assert.equal(res.rsc, 2000);
  // request() already only resolves on a message received on respTopic (see
  // mqtt-onem2m.js), but assert the exact topic string explicitly, as the brief asks.
  assert.equal(client.lastResponseTopic(), "/oneM2M/resp/SM/Mobius4/json");
});

test("rqi is echoed, and two in-flight requests are correlated by rqi rather than by arrival order", async () => {
  // Issue both requests before awaiting either. If correlation were done by "match the next
  // response to the oldest pending request" instead of by rqi, this would still happen to pass
  // when awaited sequentially -- launching them together is what actually exercises the race.
  const p1 = client.retrieve(mq.CSE_BASE);
  const p2 = client.retrieve(root.sid);
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1.rsc, 2000);
  assert.equal(r2.rsc, 2000);
  assert.notEqual(r1.rqi, r2.rqi, "each request should get its own rqi echoed back");
  // The real proof of correlation: each response carries the representation of the resource
  // *its own* request asked for, not the other one's.
  assert.ok(r1.pc["m2m:cb"], `expected the CSEBase representation, got: ${JSON.stringify(r1.pc)}`);
  assert.ok(r2.pc["m2m:cnt"], `expected the container representation, got: ${JSON.stringify(r2.pc)}`);
});

test("CRUD round-trip over MQTT: create 2001 / retrieve 2000 / update 2004 / delete 2002", async () => {
  const rn = mq.uniqueRn("crud");

  const c = await client.create(root.sid, 3, { "m2m:cnt": { rn } });
  assert.equal(c.rsc, 2001, `create failed: ${JSON.stringify(c)}`);

  const sid = `${root.sid}/${rn}`;
  const r = await client.retrieve(sid);
  assert.equal(r.rsc, 2000);
  assert.equal(r.pc["m2m:cnt"].rn, rn);

  const u = await client.update(sid, { "m2m:cnt": { lbl: ["mqtt-tag"] } });
  assert.equal(u.rsc, 2004);
  const afterUpdate = await client.retrieve(sid);
  assert.deepEqual(afterUpdate.pc["m2m:cnt"].lbl, ["mqtt-tag"]);

  const d = await client.remove(sid);
  assert.equal(d.rsc, 2002);
});

test("a structured originator (Mobius4:CAE123) gets answered on the matching structured response topic", async () => {
  // TS-0010: an SP-relative ID occupying a single topic segment has its leading '/' dropped and
  // any embedded '/' replaced with ':' -- '/Mobius4/CAE123' becomes 'Mobius4:CAE123'. This pins
  // down that bindings/mqtt.js's req_topic.split('/')[3] parses a spec-formatted structured ID
  // correctly, not just the plain unstructured originators ("SM") the other tests use.
  //
  // "CAE123" is not a registered <AE>, so this legitimately draws an access-denied rsc.
  // Asserting only topic routing and rqi correlation here -- not rsc -- is deliberate: asserting
  // success would quietly turn this into an access-control test and make it fragile to
  // unrelated ACP changes.
  const structClient = await mq.connect(broker.port, { originator: "/Mobius4/CAE123" });
  try {
    assert.equal(structClient.reqTopic, "/oneM2M/req/Mobius4:CAE123/Mobius4/json");
    assert.equal(structClient.respTopic, "/oneM2M/resp/Mobius4:CAE123/Mobius4/json");

    const res = await structClient.retrieve(mq.CSE_BASE);
    assert.equal(structClient.lastResponseTopic(), "/oneM2M/resp/Mobius4:CAE123/Mobius4/json");
    assert.ok(res.rqi, "the response should carry the rqi it was correlated on");
    assert.equal(typeof res.rsc, "number", "rsc should still be a JSON number over MQTT");
  } finally {
    await structClient.end();
  }
});

test("MQTT notification delivery: nu's ?ct= stripping and /json suffixing", async () => {
  // This is the only coverage cse/noti.js's mqtt_noti gets: its topic derivation from nu
  // ('mqtt://<ip>:<port>/<topic>', with any '?ct=...' query stripped and '/json' appended) is
  // exercised nowhere else in the suite.
  const cntRn = mq.uniqueRn("ncnt");
  const c = await client.create(root.sid, 3, { "m2m:cnt": { rn: cntRn } });
  assert.equal(c.rsc, 2001);
  const cntSid = `${root.sid}/${cntRn}`;

  const topicBase = mq.uniqueRn("ntopic");
  const notiTopic = `${topicBase}/json`;
  await client.subscribeTopic(notiTopic);

  const subRn = mq.uniqueRn("nsub");
  // Deliberately include a '?ct=json' suffix on nu, matching the oneM2M MQTT URL convention
  // (mqtt://<ip>:<port>/<topic>?ct=json) -- mqtt_noti strips it and re-appends '/json' itself,
  // so if that stripping regressed, the notification would land on the wrong topic and this
  // test would time out.
  const nu = `mqtt://127.0.0.1:${broker.port}/${topicBase}?ct=json`;
  const s = await client.create(cntSid, 23, {
    "m2m:sub": { rn: subRn, nu: [nu], enc: { net: [3] }, nct: 1 },
  });
  assert.equal(s.rsc, 2001, `subscription create failed: ${JSON.stringify(s)}`);
  const subSid = `${cntSid}/${subRn}`;

  // Trigger the net=3 event (creation of a direct child).
  const cin = await client.create(cntSid, 4, { "m2m:cin": { con: { v: 1 } } });
  assert.equal(cin.rsc, 2001);

  const got = await client.waitForMessage((item) => item.topic === notiTopic && item.body && item.body.pc);
  const sgn = got.body.pc["m2m:sgn"];
  assert.ok(sgn, `the notification should carry m2m:sgn: ${JSON.stringify(got.body)}`);
  assert.equal(sgn.sur, subSid);
  assert.equal(sgn.nev.net, 3);
});

test("cross-binding consistency: a resource created over HTTP is the same one retrieved over MQTT", async () => {
  const rn = mq.uniqueRn("xbind");
  const c = await httpCreate(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
  assert.equal(c.rsc, "2001", "created over HTTP (rsc is the string form here)");

  const r = await client.retrieve(`${root.sid}/${rn}`);
  assert.equal(r.rsc, 2000, "retrieved over MQTT (rsc is the number form here)");
  assert.equal(r.pc["m2m:cnt"].rn, rn, "both bindings are views onto the same store");
});
