"use strict";
// Spawns mobius4 as a child process with a test-only configuration.
//
// Why the config is injected through the NODE_CONFIG environment variable instead of
// config/test.json (DEC-037): in node-config's merge order, local.json (priority 9)
// overrides {deployment}.json (priority 3). Measured: with config/test.json the port stayed
// 7599 and mqtt stayed true, so the tests hit the development instance.
// config/local-test.json cannot be committed because it is in .gitignore.

const { spawn } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TEST_DB = "mobius4_test";
const START_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 5000;

// Let the OS pick a free port — a fixed port would collide with the development instance or
// with a parallel run.
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

// Diagnostic buffer cap — keep only the last ~64KB so a chatty server cannot grow it without
// bound.
const DIAG_BUFFER_MAX = 64 * 1024;

// Send SIGTERM and escalate to SIGKILL if the child has not exited after STOP_TIMEOUT_MS.
// Shared by stopServer() and the START_TIMEOUT_MS branch in startServer(): on a startup timeout
// the caller never receives a stop handle, so nobody else can clean up the child — the kill has
// to happen right here. It is fire-and-forget on purpose: a hung child must not turn a 30s
// startup timeout into a 35s one by making the rejection wait for the exit event.
function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const force = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
  child.once("exit", () => clearTimeout(force));
  child.kill("SIGTERM");
}

async function startServer({ mqttPort } = {}) {
  const port = await freePort();
  // bindings/http.js has no enabled flag for the https listener and unconditionally listens
  // on config.https.port (7580 by default). The development instance already holds that
  // port, so we pick a separate free port here too and avoid the clash (HTTPS itself is not
  // what these tests set out to verify).
  const httpsPort = await freePort();
  const overrides = {
    http: { port },
    https: { port: httpsPort },
    db: { name: TEST_DB },
    // MQTT is disabled by default: most tests only exercise the HTTP binding, and there is no
    // broker running unless a test starts one. A test that wants MQTT coverage spawns its own
    // broker via startBroker() (test/helpers/broker.js) and passes its port here.
    mqtt: mqttPort
      ? { enabled: true, ip: "127.0.0.1", port: mqttPort }
      : { enabled: false },
    // default.json turns on file logging to logs/mobius4.log, so we explicitly turn it off.
    // Console logging stays on — logger.js writes only to stdout and never to stderr, so
    // when startup fails the clue is in stdout (a fatal log, for example). That is why we
    // collect both stdout and stderr.
    logging: { level: "error", file: { enabled: false } },
  };

  const child = spawn(process.execPath, ["mobius4.js"], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: "test", NODE_CONFIG: JSON.stringify(overrides) },
    // ipc: mobius4.js sends process.send('ready') once main() completes (this is what PM2's
    // wait_ready hooks into). It lets us detect startup completion deterministically,
    // without HTTP polling.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  let diag = "";
  function appendDiag(chunk) {
    diag += chunk.toString();
    if (diag.length > DIAG_BUFFER_MAX) diag = diag.slice(diag.length - DIAG_BUFFER_MAX);
  }
  // Both pipes must be consumed — an unread pipe fills its buffer and stalls the child process.
  child.stdout.on("data", appendDiag);
  child.stderr.on("data", appendDiag);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      // The startup wait timed out before startServer() returned a stop handle to the caller,
      // so this is the only place that can clean up the orphaned child (which otherwise holds a
      // DB pool and two listening sockets).
      killChild(child);
      // Stop reading rather than waiting for the pipes to see EOF: nothing here guarantees a
      // hung child hasn't spawned a subprocess that inherited these fds, which would otherwise
      // hold the pipe open — and with it, the event loop — long after the child we signaled
      // above has exited. diag already has everything captured up to this point, so nothing is
      // lost.
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`server startup timed out (${START_TIMEOUT_MS}ms). output:\n${diag}`));
    }, START_TIMEOUT_MS);

    const onMessage = (m) => { if (m === "ready") { cleanup(); resolve(); } };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`server exited during startup (code=${code}). output:\n${diag}`));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    }
    child.on("message", onMessage);
    child.on("exit", onExit);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  return { child, port, httpsPort, baseUrl, diagnostics: () => diag, stop: () => stopServer(child) };
}

function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    killChild(child);
  });
}

module.exports = { startServer, stopServer, freePort, TEST_DB };
