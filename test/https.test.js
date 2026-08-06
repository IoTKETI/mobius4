"use strict";
// The HTTPS listener, in both of its states.
//
// It became optional in v4.7.0. Before that it started unconditionally and read three files from
// certs/ at module load, so a checkout without them could not run at all. test/boot.test.js
// asserts the new default from the outside — no listener, no TLS material needed. This file
// covers the other half: that turning it on still produces a working TLS endpoint, and that
// turning it on with nothing to read stops the process instead of quietly serving plain HTTP.
//
// v4.7.0 also dropped requestCert/rejectUnauthorized. That looked like mutual TLS but nothing
// ever read the certificate the client presented — there is no getPeerCertificate call in this
// source — so the handshake proved possession of a CA-signed certificate and never that the
// holder was the originator the request claimed. The first test below pins what replaced it: a
// client with no certificate at all is served.
//
// The certificate is generated here rather than committed. Committing one is how this repository
// ended up with a private key in its history (see docs/tls.md), and a fixture would expire.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const TEST_DB = require("./helpers/server").TEST_DB;
const ADMIN = "Shttps-test";

let tmpdir, keyPath, certPath;

// openssl is present on the CI images and on developer machines, but a missing one should read
// as "not exercised" rather than as a failure of the listener.
const hasOpenssl = spawnSync("openssl", ["version"], { encoding: "utf8" }).status === 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Starts mobius4 with the given https settings. Resolves with how it ended: "ready" when the
// process signalled it is up, or the exit code when it gave up first.
function startWith(httpsConfig) {
  return new Promise(async (resolve) => {
    const overrides = {
      http: { port: await freePort() },
      https: httpsConfig,
      db: { name: TEST_DB },
      cse: { admin: ADMIN },
      mqtt: { enabled: false },
      logging: { level: "info", console: { enabled: true, pretty: false }, file: { enabled: false } },
    };
    const child = spawn(process.execPath, ["mobius4.js"], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: "test", NODE_CONFIG: JSON.stringify(overrides) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));

    const settle = (outcome) =>
      resolve({ outcome, output, stop: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); }) });

    const timer = setTimeout(() => settle("timeout"), 30000);
    child.on("message", (m) => { if (m === "ready") { clearTimeout(timer); settle("ready"); } });
    child.on("exit", (code) => { clearTimeout(timer); settle(`exit ${code}`); });
  });
}

before(() => {
  if (!hasOpenssl) return;
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "mobius4-tls-"));
  keyPath = path.join(tmpdir, "server.key");
  certPath = path.join(tmpdir, "server.crt");
  const made = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-nodes",
    "-keyout", keyPath, "-out", certPath,
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { encoding: "utf8" });
  assert.equal(made.status, 0, `could not generate a test certificate: ${made.stderr}`);
});

after(() => {
  if (tmpdir) fs.rmSync(tmpdir, { recursive: true, force: true });
});

test("serves oneM2M over TLS to a client that presents no certificate", { skip: !hasOpenssl && "openssl not available" }, async () => {
  const port = await freePort();
  const srv = await startWith({ enabled: true, port, key: keyPath, cert: certPath, chain: "" });
  assert.equal(srv.outcome, "ready", `the server should have started: ${srv.output.slice(-600)}`);
  assert.match(srv.output, /HTTPS server listening/);

  try {
    const res = await new Promise((resolve, reject) => {
      const req = https.request({
        host: "127.0.0.1", port, path: "/Mobius", method: "GET",
        // The certificate is self-signed, so its issuer is not trusted here. What matters is
        // that no client certificate is offered and the request is still served — that is the
        // behaviour that replaced requestCert/rejectUnauthorized.
        rejectUnauthorized: false,
        headers: { "X-M2M-Origin": ADMIN, "X-M2M-RI": "tls1", "X-M2M-RVI": "3", Accept: "application/json" },
      }, (r) => {
        let body = "";
        r.on("data", (d) => (body += d));
        r.on("end", () => resolve({ status: r.statusCode, rsc: r.headers["x-m2m-rsc"], body }));
      });
      req.on("error", reject);
      req.end();
    });

    assert.equal(res.status, 200);
    assert.equal(res.rsc, "2000", "a client with no certificate must reach the <CSEBase>");
    assert.equal(JSON.parse(res.body)["m2m:cb"].rn, "Mobius");
  } finally {
    await srv.stop();
  }
});

test("refuses to start when HTTPS is enabled and the key cannot be read", async () => {
  // Serving plain HTTP because the certificate was missing would be the worst of the three
  // outcomes: whoever set the flag asked for encryption, and a silent downgrade is not visible
  // from the client side either.
  const srv = await startWith({
    enabled: true, port: await freePort(),
    key: "certs/does-not-exist.key", cert: "certs/does-not-exist.crt", chain: "",
  });

  assert.equal(srv.outcome, "exit 1", `startup should have stopped: ${srv.output.slice(-400)}`);
  assert.match(srv.output, /https\.key/, "the message should name the setting, not only the file");
  assert.match(srv.output, /does-not-exist\.key/);
});
