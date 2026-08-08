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
