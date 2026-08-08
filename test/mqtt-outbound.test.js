"use strict";
// Outbound MQTT: publishing to the broker a URL names, and forwarding a request over MQTT.
//
// Everything outbound used to go through the single client in bindings/mqtt.js — the broker this
// CSE listens on. Two consequences:
//
//   - A <subscription> whose notificationURI named another host was published to the local broker
//     under the right topic. Right topic, wrong server: the logs look identical and nothing is
//     delivered.
//   - A <remoteCSE> reachable only over MQTT could not be reached. Worse, the branch was empty and
//     fell through to an unconditional OK, so a request that went nowhere was reported as success.
//
// URL and topic rules are TS-0010: 6.6.2 (mqtt URL form and default ports), 6.6.4 (outside a
// pointOfAccess the path "gives the entire MQTT topic string"), 6.4.2/6.4.3 (the request and
// response topic names, with each identifier's leading "/" dropped and the rest turned into ":").
//
// The parsing and topic construction are tested directly; delivery against a live broker is
// covered by test/mqtt.test.js, which starts one.

const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
process.env.NODE_CONFIG = JSON.stringify({
  cse: { admin: "test-admin", cse_id: "/mobius4" },
  mqtt: { enabled: true, ip: "127.0.0.1", port: 1883 },
  logging: { level: "error", file: { enabled: false } },
});

const outbound = require("../bindings/mqtt-outbound");

test("an mqtt URL splits into a broker authority and the whole path as the topic", () => {
  // TS-0010:6.6.4 — the path is the entire topic and need not follow any standard pattern.
  const parsed = outbound.parse_mqtt_url("mqtt://broker.example:1883/my/own/topic");

  assert.equal(parsed.authority, "mqtt://broker.example:1883");
  assert.equal(parsed.topic, "my/own/topic");
});

test("the default port comes from the scheme", () => {
  // TS-0010:6.6.2 — 1883 for mqtt, 8883 for mqtts.
  assert.equal(outbound.parse_mqtt_url("mqtt://h/t").authority, "mqtt://h:1883");
  assert.equal(outbound.parse_mqtt_url("mqtts://h/t").authority, "mqtts://h:8883");
});

test("a non-mqtt URL is rejected", () => {
  assert.equal(outbound.parse_mqtt_url("http://h/t"), null);
  assert.equal(outbound.parse_mqtt_url("not a url"), null);
});

test("the request topic follows TS-0010:6.4.2", () => {
  // "/mobius4" -> "mobius4"; an SP-relative id keeps its inner separators as ":".
  assert.equal(
    outbound.request_topic("/mobius4", "/remote-cse"),
    "/oneM2M/req/mobius4/remote-cse/json"
  );
  assert.equal(
    outbound.request_topic("//sp.example/in-cse", "/remote"),
    "/oneM2M/req/:sp.example:in-cse/remote/json"
  );
});

test("the response topic mirrors it, with the same identifier order", () => {
  assert.equal(
    outbound.response_topic("/mobius4", "/remote-cse"),
    "/oneM2M/resp/mobius4/remote-cse/json"
  );
});

test("publishing to a URL with no path is refused", async () => {
  // A notificationURI has to carry the topic; without one there is nothing to publish to.
  const ok = await outbound.publish_to_url("mqtt://broker.example:1883", { a: 1 });
  assert.equal(ok, false);
});

test("a broker that cannot be reached reports failure rather than throwing", async (t) => {
  // 127.0.0.1:1 has nothing listening. The caller decides what to do with false; an exception
  // here would take down the notification loop for every other subscriber.
  const ok = await outbound.publish_to_url("mqtt://127.0.0.1:1/some/topic", { a: 1 });
  assert.equal(ok, false);

  t.after(() => outbound.disconnect_all());
});

test("forwarding over the CSE's own broker is refused", async () => {
  // It would publish a request onto the topic this CSE is itself subscribed to and wait for an
  // answer from itself.
  const resp = await outbound.request_over_mqtt("mqtt://127.0.0.1:1883", { rqi: "x" }, "/remote");
  assert.equal(resp, null);
});

// ── Against a live broker ────────────────────────────────────────────────────────────────────
// These need mosquitto on PATH; test/helpers/broker.js skips the file when it is missing, the
// same as test/mqtt.test.js.

const { startBroker } = require("./helpers/broker");
const MQTT = require("async-mqtt");

test("two forwards to the same CSE do not cut each other off", async (t) => {
  // The defect this pins down: the response topic was subscribed per request and unsubscribed
  // when that request finished. Two forwards to the same <remoteCSE> share that topic, so the
  // first to complete unsubscribed the second, which then waited for an answer it could no longer
  // receive and timed out. Now the subscription is made once and left in place.
  let broker;
  try {
    broker = await startBroker();
  } catch {
    return t.skip("mosquitto is not available");
  }
  t.after(async () => {
    await outbound.disconnect_all();
    await broker.stop();
  });

  const url = `mqtt://127.0.0.1:${broker.port}`;

  // Stand-in for the remote CSE: answers on the response topic, slowly for the first request so
  // that both are in flight at once.
  const responder = await MQTT.connectAsync(url, { reconnectPeriod: 0 });
  const req_topic = outbound.request_topic("/mobius4", "/remote");
  const resp_topic = outbound.response_topic("/mobius4", "/remote");
  await responder.subscribe(req_topic);
  responder.on("message", async (_topic, payload) => {
    const req = JSON.parse(payload.toString());
    const delay = req.rqi === "slow" ? 300 : 0;
    setTimeout(() => {
      responder.publish(resp_topic, JSON.stringify({ rqi: req.rqi, rsc: "2000" })).catch(() => {});
    }, delay);
  });
  t.after(async () => { await responder.end(true); });

  const [slow, fast] = await Promise.all([
    outbound.request_over_mqtt(url, { rqi: "slow", op: 2 }, "/remote", 5000),
    outbound.request_over_mqtt(url, { rqi: "fast", op: 2 }, "/remote", 5000),
  ]);

  assert.equal(fast?.rsc, "2000", "the request that finished first was answered");
  assert.equal(slow?.rsc, "2000", "and so was the one still in flight when it did");
  assert.equal(slow.rqi, "slow", "answers are matched by rqi, not by arrival order");
});

test("an idle connection is collected, a busy one is not", async (t) => {
  // Garbage collection, not pooling: the window is long enough that a subscription firing a few
  // times an hour keeps finding a warm socket. Driven directly here rather than waiting it out.
  let broker;
  try {
    broker = await startBroker();
  } catch {
    return t.skip("mosquitto is not available");
  }
  t.after(async () => {
    await outbound.disconnect_all();
    await broker.stop();
  });

  const url = `mqtt://127.0.0.1:${broker.port}/some/topic`;
  assert.equal(await outbound.publish_to_url(url, { a: 1 }), true);
  assert.equal(outbound.open_broker_count(), 1);

  // Just used, so a sweep leaves it alone.
  await outbound.sweep_idle();
  assert.equal(outbound.open_broker_count(), 1, "a connection in use is not collected");

  // Pretend the idle window has passed.
  outbound.__set_last_used_for_test(`mqtt://127.0.0.1:${broker.port}`,
    Date.now() - outbound.IDLE_TTL_MS - 1);
  await outbound.sweep_idle();
  assert.equal(outbound.open_broker_count(), 0, "an idle connection is closed");
});

test("a second publish to the same broker reuses the connection", async (t) => {
  // Connection per message would make MQTT a slower HTTP. Publishing twice must not open twice.
  let broker;
  try {
    broker = await startBroker();
  } catch {
    return t.skip("mosquitto is not available");
  }
  t.after(async () => {
    await outbound.disconnect_all();
    await broker.stop();
  });

  const url = `mqtt://127.0.0.1:${broker.port}/some/topic`;
  assert.equal(await outbound.publish_to_url(url, { a: 1 }), true);
  assert.equal(await outbound.publish_to_url(url, { a: 2 }), true);

  assert.equal(outbound.open_broker_count(), 1, "one connection served both publishes");
});
