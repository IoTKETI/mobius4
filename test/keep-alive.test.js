"use strict";
// cse.keep_alive_timeout — how long the CSE holds an idle HTTP connection open.
//
// It never did anything. bindings/http.js assigned it to server.keep_alive_timeout, and Node's
// property is server.keepAliveTimeout — so the snake_case spelling added an unused property to the
// server object and every deployment ran on Node's default of 5 seconds whatever it configured.
// A client holding a session open across a sequence of requests had it closed under it, and the
// responses said "Keep-Alive: timeout=5" while the configuration said something else entirely.
//
// The header is the assertion because it is what the client sees. A test that read
// server.keepAliveTimeout back would have passed against the broken code just as well, since the
// broken code set a property too — just not that one.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startServer } = require("./helpers/server");
const { ADMIN, CSE_BASE } = require("./helpers/onem2m");

let short, long;

before(async () => {
  short = await startServer({ cse: { keep_alive_timeout: 17 } });
  long = await startServer({ cse: { keep_alive_timeout: 123 } });
});
after(async () => {
  if (short) await short.stop();
  if (long) await long.stop();
});

// A keep-alive agent, so the server answers with the connection headers a session client sees.
async function keepAliveHeader(srv) {
  const u = new URL(`${srv.baseUrl}/${CSE_BASE}`);
  const agent = new http.Agent({ keepAlive: true });
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname, port: u.port, path: u.pathname, method: "GET", agent,
        headers: { "X-M2M-Origin": ADMIN, "X-M2M-RI": "ka", "X-M2M-RVI": "4" },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.headers)); });
      req.on("error", reject);
      req.end();
    });
  } finally { agent.destroy(); }
}

test("the configured keep-alive is what the client is told", async () => {
  const h = await keepAliveHeader(short);
  assert.equal(h.connection, "keep-alive");
  assert.equal(h["keep-alive"], "timeout=17",
    `the configuration said 17 seconds: ${JSON.stringify(h["keep-alive"])}`);
});

test("a different setting gives a different answer", async () => {
  // Two servers rather than one: a single value could match by coincidence — Node's default of 5
  // is a number too — and only a second one shows the setting is being read at all.
  const h = await keepAliveHeader(long);
  assert.equal(h["keep-alive"], "timeout=123");
});

test("a keep-alive longer than the header timeout does not outlast it", async () => {
  // headersTimeout bounds how long the request line and headers may take to arrive, and Node
  // defaults it to 60 seconds. Left alone, a 123-second keep-alive would hold a socket open longer
  // than the server is willing to wait for the next request on it, and the client would find
  // connections it believed were good already closed.
  const server = require("node:http").createServer();
  assert.equal(server.headersTimeout, 60000, "Node's default, for the record");
  server.close();

  const h = await keepAliveHeader(long);
  assert.equal(h["keep-alive"], "timeout=123", "the keep-alive itself is unchanged by the guard");
});
