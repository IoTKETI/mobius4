"use strict";
// oneM2M HTTP client. The tests deliberately go out over HTTP so that they travel the
// same path a real client does (binding -> access control -> DB).

const CSE_BASE = "Mobius";   // config.cse.csebase_rn
const ADMIN = "test-admin";  // config.cse.admin — must match TEST_ADMIN in helpers/server.js.
                             // The default ACP's acop has no delete bit (code map G-2), so a
                             // regular originator gets 4103 on delete; this identity is named by
                             // the admin ACP (acop 63) that db/init.js attaches to the <CSEBase>.
                             // It is not a bypass — the v4.6.0 short-circuit is gone. A test that
                             // needs to see what a plain client sees must send its own originator:
                             // defaulting to ADMIN is what hid the <CSEBase> 4005/4103 bug.

let seq = 0;
function nextRqi() { return `t${process.pid.toString(36)}-${++seq}`; }

function uniqueRn(prefix = "t") {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${Date.now().toString(36)}${rand}`;
}

async function request(baseUrl, { method, to, ty, body, originator = ADMIN, headers = {} }) {
  const url = `${baseUrl}/${String(to).replace(/^\/+/, "")}`;
  const h = {
    "X-M2M-Origin": originator,
    "X-M2M-RI": nextRqi(),
    "X-M2M-RVI": "3",
    Accept: "application/json",
    ...headers,
  };
  const init = { method, headers: h };
  if (body !== undefined) {
    // op is derived from Content-Type (code map L-2): if ';ty=N' is present it is CREATE
    // (op=1), otherwise op comes from the HTTP method. So we branch the Content-Type on
    // whether ty was supplied.
    h["Content-Type"] = ty === undefined ? "application/json" : `application/json;ty=${ty}`;
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const raw = await res.text();
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  // cnst/cnot (Content Status / Content Offset, TS-0001:8.1.3) travel as headers, not in the
  // body, so a test that wants to see whether a result was truncated needs them exposed.
  return {
    status: res.status,
    rsc: res.headers.get("x-m2m-rsc"),
    cnst: res.headers.get("x-m2m-cts"),
    cnot: res.headers.get("x-m2m-cto"),
    body: parsed,
    raw,
  };
}

const create   = (b, to, ty, body, o = {}) => request(b, { method: "POST",   to, ty, body, ...o });
const retrieve = (b, to, o = {})           => request(b, { method: "GET",    to, ...o });
const update   = (b, to, body, o = {})     => request(b, { method: "PUT",    to, body, ...o });
const remove   = (b, to, o = {})           => request(b, { method: "DELETE", to, ...o });

function discover(b, to, query = {}, o = {}) {
  const qs = new URLSearchParams({ fu: "1", ...query }).toString();
  return request(b, { method: "GET", to: `${to}?${qs}`, ...o });
}

// The URI list of a discovery response. When there are no results mobius4 may omit the key
// entirely, so we normalize to [] here rather than making every call site defend against it.
function urils(res) {
  const u = res && res.body && res.body["m2m:uril"];
  if (Array.isArray(u)) return u;
  if (typeof u === "string") return [u];
  return [];
}

// mobius4's delete_a_res (cse/hostingCSE.js) deletes the target resource — and its
// descendants — fire-and-forget, without awaiting (the 2002 response goes out first and the
// deletion continues in the background). If a test SIGTERMs the server via srv.stop()
// immediately after remove(), that async deletion is cut off mid-flight and orphan rows are
// left in the DB — and retrieving an orphan by ri never comes back at all (timeout), which
// can contaminate later test runs too. So after a DELETE we do not sleep for a fixed time;
// we poll with discovery until the subtree is genuinely empty, then return.
const REMOVE_WAIT_TIMEOUT_MS = 5000;
const REMOVE_WAIT_INTERVAL_MS = 100;

// Polls until nothing under sid (and sid itself) is discoverable any more.
//
// Careful: do not aim discover(baseUrl, sid) at sid itself — delete_a_res dispatches the
// deletion of the target resource itself (hostingCSE.js:559) and the deletion of its
// descendants (hostingCSE.js:592) as two separate fire-and-forget tasks, and the former (a
// single row) really does finish before the latter (N rows processed sequentially) at times.
// Once sid's own row disappears first, reqPrim.js returns early (the 4004 guard in
// reqPrim.js — if 'to' cannot be resolved it answers 4004 immediately without ever reaching
// discovery), so the poll would wrongly conclude "done" while descendants are still around
// (measured: with that approach a descendant container was left orphaned after three
// consecutive runs). So we always target the always-alive CSE_BASE for discovery and decide
// client-side by filtering the response on the sid prefix.
async function waitForSubtreeGone(baseUrl, sid) {
  const deadline = Date.now() + REMOVE_WAIT_TIMEOUT_MS;
  for (;;) {
    const res = await discover(baseUrl, CSE_BASE);
    const remaining = urils(res).filter((u) => u === sid || u.startsWith(`${sid}/`));
    if (remaining.length === 0) return;
    // Never throw on timeout — a slow cleanup must not mask a real test failure. Any
    // leftover orphans surface as a growing DB row count on the next run.
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, REMOVE_WAIT_INTERVAL_MS));
  }
}

// Each test file creates one root of its own under the <CSEBase> and, when done, deletes
// only that subtree.
async function createRoot(baseUrl, prefix = "t") {
  const rn = uniqueRn(prefix);
  const res = await create(baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn } });
  if (res.rsc !== "2001") {
    throw new Error(`failed to create test root: rsc=${res.rsc} body=${res.raw.slice(0, 200)}`);
  }
  const sid = `${CSE_BASE}/${rn}`;
  return {
    rn, sid,
    remove: async () => {
      const res = await remove(baseUrl, sid);
      await waitForSubtreeGone(baseUrl, sid);
      return res;
    },
  };
}

module.exports = {
  CSE_BASE, ADMIN,
  request, create, retrieve, update, remove, discover,
  uniqueRn, createRoot, urils, waitForSubtreeGone,
};
