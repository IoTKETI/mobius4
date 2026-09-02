"use strict";
// A local notification sink for a <subscription>'s nu to point at.
//
// "wait until it arrives" (waitFor) and "confirm it never arrives" (expectNone) are
// different in kind. The former has to finish the moment the condition holds, to stay fast;
// the latter has to wait out a fixed grace period, to stay accurate. Enforcing that
// distinction in the helper keeps a test from mistaking a short timeout for "no notification".

const http = require("node:http");

function netOf(item) {
  return (item && item.body && item.body["m2m:sgn"] && item.body["m2m:sgn"].nev)
    ? item.body["m2m:sgn"].nev.net
    : null;
}

async function startSink() {
  const received = [];
  const waiters = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      // headers are recorded because a notification is a request primitive and its
      // parameters are as much part of being correct as its body -- a receiver that
      // validates them rejects the whole thing.
      const item = { url: req.url, method: req.method, headers: req.headers, body: parsed, raw };
      received.push(item);

      for (const w of waiters.slice()) {
        let matched = false;
        try { matched = w.pred(item); } catch { matched = false; }
        if (matched) {
          waiters.splice(waiters.indexOf(w), 1);
          clearTimeout(w.timer);
          w.resolve(item);
        }
      }
      // Return a oneM2M response code so the CSE judges the notification delivery a success.
      res.writeHead(200, { "X-M2M-RSC": "2000", "Content-Type": "application/json" });
      res.end("{}");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/noti`;

  function waitFor(pred, { timeoutMs = 5000 } = {}) {
    const already = received.find(pred);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(
          `timed out waiting for a notification (${timeoutMs}ms). ${received.length} received, net=` +
          JSON.stringify(received.map(netOf))
        ));
      }, timeoutMs);
      waiters.push(w);
    });
  }

  // Throws when anything matched, rather than only reporting it. The earlier version returned
  // the matches and left the assertion to the caller, which reads like an assertion and is not
  // one: `await sink.expectNone(...)` on its own passes however many notifications arrive. That
  // is exactly how a test written against the eviction guard came to pass while the guard was
  // removed. Callers may still assert on the returned array — it is always empty here — but
  // forgetting to no longer hides a failure.
  async function expectNone(pred, { graceMs = 2000 } = {}) {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    const matched = received.filter(pred);
    if (matched.length > 0) {
      throw new Error(
        `expected no matching notification, but ${matched.length} arrived: net=` +
        JSON.stringify(matched.map(netOf)) +
        ` sur=${JSON.stringify(matched.map((i) => i.body?.["m2m:sgn"]?.sur))}`
      );
    }
    return matched;
  }

  return {
    url, received, waitFor, expectNone, netOf,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startSink, netOf };
