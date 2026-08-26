"use strict";
// Runs one test body against both protocol bindings.
//
// The shape is borrowed from the conformance architecture rather than invented here. TS-0019:5.1
// describes the oneM2M ATS as one set of test purposes over four interchangeable lower layers
// ("HTTP, CoAP, WebSocket and MQTT"), and TS-0019:7.3 carries `bindingProtocol` as a per-component
// parameter rather than forking the tests. A suite that writes each binding its own copy of every
// assertion is not how the CSE will be judged, and the copies drift: the notification test in
// test/mqtt.test.js pointed `nu` at the CSE's own broker, so it could not have caught a binding
// that ignored the broker in the URL -- which is exactly the defect that was there.
//
// Why this cannot be a thin pass-through
// --------------------------------------
// The two helpers look alike -- create/retrieve/update/remove -- but the bindings put the same
// request parameters in different places, and those places are the interesting part:
//
//                     HTTP (TS-0009)                MQTT (TS-0010)
//   fu / ty / rcn     URL query string              request primitive fields (fc, rcn)
//   originator        X-M2M-Origin header           topic segment
//   operation         method + Content-Type;ty=     primitive `op`
//   correlation       the HTTP round trip           `rqi`
//
// test/helpers/onem2m.js takes a `to` with the query string already built into it, and
// test/helpers/mqtt-onem2m.js's request() has nowhere to put fc or rcn at all -- which is why no
// MQTT discovery test exists: it could not be written. So the adapter takes the request
// *structurally* and lets each binding serialize it. A test says what it wants; where that ends up
// on the wire is the binding's business, and being wrong about it is a bug this file can surface.
//
// What belongs here, and what does not
// ------------------------------------
// Only the axes where the bindings diverge: registration, operation derivation, response status
// codes, filterCriteria and rcn transport, notification delivery, error paths. Properties of one
// binding stay in their own file -- TS-0009 path forms in addressing.test.js, topic naming in
// mqtt.test.js, broker connections in mqtt-outbound.test.js. Duplicating those across bindings
// would assert nothing.

const { startServer } = require("./server");
const { startBroker } = require("./broker");
const http = require("./onem2m");
const mq = require("./mqtt-onem2m");

const BINDINGS = ["http", "mqtt"];

// Turns a structured request into the HTTP helper's `to` + options. `fc` becomes query parameters
// (TS-0009:6.2.2.2 maps filterCriteria onto the query component); `rcn` is one too.
function httpTarget(to, { fc, rcn } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(fc || {})) {
    // ty is a list in the primitive and repeats as a query parameter, rather than becoming
    // "ty=3,4" -- a difference the MQTT side does not have, and one of the reasons a test should
    // not be writing either form by hand.
    if (Array.isArray(v)) for (const item of v) qs.append(k, String(item));
    else qs.append(k, String(v));
  }
  if (rcn !== undefined) qs.append("rcn", String(rcn));
  const s = qs.toString();
  return s ? `${to}?${s}` : to;
}

// Both bindings answer with a Response Status Code, but HTTP's arrives as a header string and
// MQTT's as a number in the primitive. Tests compare against one thing, so both become strings
// here -- the value is the same either way, and normalizing at the boundary keeps the assertion
// about the code rather than about its JavaScript type.
function normalize(res, binding) {
  if (binding === "http") {
    return { rsc: res.rsc, pc: res.body, raw: res.raw, status: res.status };
  }
  return {
    rsc: res.rsc === undefined || res.rsc === null ? undefined : String(res.rsc),
    pc: res.pc,
    raw: JSON.stringify(res),
    status: undefined,
  };
}

function urils(res) {
  const u = res && res.pc && res.pc["m2m:uril"];
  if (Array.isArray(u)) return u;
  if (typeof u === "string") return [u];
  return [];
}

// One server (and, for MQTT, one broker) per call, not per test: standing a broker up costs about
// a second and nothing in these tests needs a private one.
async function startBindingContext(binding, { serverOptions = {} } = {}) {
  const broker = binding === "mqtt" ? await startBroker() : null;
  const srv = await startServer({ ...serverOptions, ...(broker ? { mqttPort: broker.port } : {}) });

  // Every client this context hands out, so stop() can close them even when a test throws
  // mid-way and never reaches its own cleanup.
  const clients = [];

  async function clientFor(originator) {
    if (binding === "http") return null;
    const c = await mq.connect(broker.port, ...(originator === undefined ? [] : [{ originator }]));
    clients.push(c);
    return c;
  }

  // The default identity, connected once. mqtt-onem2m fixes the request topic (and therefore the
  // originator segment) at connect time, so a call that sends as somebody else needs its own
  // client -- see `as()` below.
  const defaultClient = binding === "mqtt" ? await clientFor(undefined) : null;
  const asCache = new Map();

  async function clientOf(originator) {
    if (originator === undefined) return defaultClient;
    if (!asCache.has(originator)) asCache.set(originator, await clientFor(originator));
    return asCache.get(originator);
  }

  async function request({ op, to, ty, pc, fc, rcn, originator }) {
    if (binding === "http") {
      const target = httpTarget(to, { fc, rcn });
      const opts = originator === undefined ? {} : { originator };
      let res;
      if (op === 1) res = await http.create(srv.baseUrl, target, ty, pc, opts);
      else if (op === 2) res = await http.retrieve(srv.baseUrl, target, opts);
      else if (op === 3) res = await http.update(srv.baseUrl, target, pc, opts);
      else if (op === 4) res = await http.remove(srv.baseUrl, target, opts);
      else throw new Error(`unsupported op ${op}`);
      return normalize(res, "http");
    }

    const client = await clientOf(originator);
    // The MQTT helper builds the primitive itself, so fc/rcn are passed through as the extra
    // fields they are on the wire.
    const res = await client.request({ op, to, ty, pc, fc, rcn });
    return normalize(res, "mqtt");
  }

  async function stop() {
    for (const c of clients) {
      try { await c.end(); } catch { /* a client whose broker already died has nothing to flush */ }
    }
    if (srv) await srv.stop();
    if (broker) await broker.stop();
  }

  return {
    binding,
    baseUrl: srv.baseUrl,
    brokerPort: broker ? broker.port : null,
    server: srv,
    request,
    create:   (to, ty, pc, o = {}) => request({ op: 1, to, ty, pc, ...o }),
    retrieve: (to, o = {})         => request({ op: 2, to, ...o }),
    update:   (to, pc, o = {})     => request({ op: 3, to, pc, ...o }),
    remove:   (to, o = {})         => request({ op: 4, to, ...o }),
    discover: (to, fc = {}, o = {}) => request({ op: 2, to, fc: { fu: 1, ...fc }, ...o }),
    urils,
    stop,
  };
}

module.exports = { BINDINGS, startBindingContext, urils, httpTarget };
