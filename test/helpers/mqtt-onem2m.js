"use strict";
// oneM2M-over-MQTT client. The MQTT analogue of onem2m.js: these tests deliberately travel
// the real MQTT path (broker -> bindings/mqtt.js -> access control -> DB) rather than calling
// into the binding in-process, for the same reason onem2m.js goes out over HTTP instead of
// requiring bindings/http.js directly.
//
// MQTT gives no request/response pairing of its own -- unlike HTTP, a publish does not hand
// back "the" reply. Responses are correlated by the primitive's `rqi` (Request Identifier),
// which bindings/mqtt.js echoes straight from the request (reqPrim.js:37).

const mqtt = require("mqtt");
const { CSE_BASE, ADMIN, uniqueRn } = require("./onem2m");

// The hosting CSE's SP-relative CSE-ID (config.cse.cse_id). This is distinct from CSE_BASE
// (config.cse.csebase_rn, "Mobius") imported above: CSE_BASE names the <CSEBase> resource,
// CSE_ID names the CSE itself, and it is CSE_ID that bindings/mqtt.js uses to build both its
// request subscription topic (mqtt.js:60) and every response topic (mqtt.js:98).
const CSE_ID = "/Mobius4";

// TS-0010 (MQTT binding) topic ID formatting: an ID occupying a single MQTT topic segment is
// the SP-relative ID with its leading '/' dropped and any embedded '/' replaced by ':'.
// e.g. '/Mobius4' -> 'Mobius4', '/Mobius4/CAE123' -> 'Mobius4:CAE123'. This is what makes
// bindings/mqtt.js:97's `req_topic.split('/')[3]` correct -- the originator always occupies
// exactly one topic level.
function toTopicId(id) {
  return String(id).replace(/^\/+/, "").split("/").join(":");
}

const RECEIVER = toTopicId(CSE_ID); // "Mobius4"

const DEFAULT_TIMEOUT_MS = 5000;

let seq = 0;
function nextRqi() { return `mq${process.pid.toString(36)}-${++seq}`; }

// Connects to the given broker port and returns a client bound to `originator`. The response
// topic is subscribed (and its SUBACK awaited) before connect() resolves, so a caller that
// immediately calls request() cannot lose a fast response to a subscribe-after-publish race.
async function connect(brokerPort, { originator = ADMIN } = {}) {
  const client = mqtt.connect(`tcp://127.0.0.1:${brokerPort}`, {
    // The test broker (test/helpers/broker.js) is ephemeral and private to one test run, so
    // there is nothing to reconnect to once it is gone -- unlike bindings/mqtt.js, this client
    // does not need reconnect/backoff logic.
    reconnectPeriod: 0,
    connectTimeout: 10000,
  });

  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });

  const originatorTopicId = toTopicId(originator);
  const reqTopic = `/oneM2M/req/${originatorTopicId}/${RECEIVER}/json`;
  const respTopic = `/oneM2M/resp/${originatorTopicId}/${RECEIVER}/json`;

  // rqi -> { resolve, timer }, for correlating responses to their request.
  const pending = new Map();
  // Every message this client has received on any subscribed topic, kept for diagnosable
  // timeout messages (see waitForMessage / request below) -- modeled on noti-sink.js.
  const received = [];
  // Free-form waiters registered via waitForMessage(), independent of the rqi correlation
  // used by request().
  const waiters = [];
  let lastRespTopic = null;

  client.on("message", (topic, payload) => {
    let body = null;
    try { body = JSON.parse(payload.toString()); } catch { body = null; }
    const item = { topic, body, raw: payload.toString() };
    received.push(item);

    if (topic === respTopic && body && body.rqi != null) {
      const p = pending.get(body.rqi);
      // A response whose rqi matches nothing pending is ignored, not handed to the current
      // waiter -- MQTT provides no request/response pairing, so a stray or duplicate response
      // must never be mistaken for the answer to a different, still-pending request.
      if (p) {
        lastRespTopic = topic;
        pending.delete(body.rqi);
        clearTimeout(p.timer);
        p.resolve(body);
      }
    }

    for (const w of waiters.slice()) {
      let matched = false;
      try { matched = w.pred(item); } catch { matched = false; }
      if (matched) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(item);
      }
    }
  });

  function subscribeTopic(topic) {
    return new Promise((resolve, reject) => {
      client.subscribe(topic, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // Await the SUBACK for the response topic before connect() resolves -- see the function
  // comment above.
  await subscribeTopic(respTopic);

  function waitForMessage(pred, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const already = received.find(pred);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(
          `timed out waiting for an mqtt message (${timeoutMs}ms). ${received.length} received, topics=` +
          JSON.stringify(received.map((r) => r.topic))
        ));
      }, timeoutMs);
      waiters.push(w);
    });
  }

  // Publishes a request primitive and resolves with the response primitive matched by rqi.
  // originator may be overridden per-call (e.g. to send as an unregistered AE); the request
  // and response topics stay fixed to the ones this client subscribed at connect() time, since
  // bindings/mqtt.js derives the response topic from the *request topic's* originator segment
  // (mqtt.js:97), not from the primitive's `fr`, and that segment is fixed to whatever this
  // client subscribed at connect() time.
  function request({ op, to, ty, pc, originator: fr = originator, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const rqi = nextRqi();
    const reqPrim = { op, to, fr, rqi, rvi: "3" };
    if (ty !== undefined) reqPrim.ty = ty;
    if (pc !== undefined) reqPrim.pc = pc;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(rqi);
        reject(new Error(
          `timed out waiting for mqtt response (rqi=${rqi}, ${timeoutMs}ms), subscribed to ` +
          `${respTopic}. ${received.length} messages arrived: ` +
          JSON.stringify(received.map((r) => ({ topic: r.topic, rqi: r.body && r.body.rqi })))
        ));
      }, timeoutMs);
      pending.set(rqi, { resolve, timer });

      client.publish(reqTopic, JSON.stringify(reqPrim), (err) => {
        if (err) {
          clearTimeout(timer);
          pending.delete(rqi);
          reject(err);
        }
      });
    });
  }

  const create   = (to, ty, pc, o = {}) => request({ op: 1, to, ty, pc, ...o });
  const retrieve = (to, o = {})         => request({ op: 2, to, ...o });
  const update   = (to, pc, o = {})     => request({ op: 3, to, pc, ...o });
  const remove   = (to, o = {})         => request({ op: 4, to, ...o });

  function end() {
    return new Promise((resolve) => client.end(false, {}, resolve));
  }

  return {
    reqTopic, respTopic,
    request, create, retrieve, update, remove,
    subscribeTopic, waitForMessage,
    lastResponseTopic: () => lastRespTopic,
    received,
    end,
  };
}

module.exports = { connect, toTopicId, CSE_BASE, CSE_ID, ADMIN, uniqueRn };
