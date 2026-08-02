"use strict";
// Spawns a dedicated, ephemeral mosquitto broker for the MQTT binding tests.
//
// Why not just point the tests at the developer's own broker on port 1883: a
// development mobius4 instance subscribes to /oneM2M/req/+/<cse_id>/json with
// the same cse_id the tests use, so it would race the tests to answer their
// own requests, non-deterministically. Spawning a private broker on a free
// port removes that collision entirely, the same way this harness already
// picks free ports for mobius4's HTTP and HTTPS listeners.

const { spawn } = require("node:child_process");
const net = require("node:net");
const { freePort } = require("./server");

const START_TIMEOUT_MS = 10000;
const STOP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 50;

// Diagnostic buffer cap — keep only the last ~64KB so a chatty broker cannot grow it without
// bound.
const DIAG_BUFFER_MAX = 64 * 1024;

// Poll a raw TCP connect until it succeeds instead of resolving on a fixed delay — mosquitto
// with no config file (local-only mode, anonymous connections allowed) starts in well under a
// second, but a fixed sleep is exactly the kind of flakiness that erodes trust in a suite.
function waitForPort(port, deadline) {
  return new Promise((resolve, reject) => {
    (function attempt() {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for broker to accept connections on port ${port}`));
        } else {
          setTimeout(attempt, POLL_INTERVAL_MS);
        }
      });
    })();
  });
}

// Send SIGTERM and escalate to SIGKILL if the child has not exited after STOP_TIMEOUT_MS.
// Shared by stopBroker() and the startup-failure path in startBroker(): on a startup failure
// the caller never receives a stop handle, so nobody else can clean up the child — the kill has
// to happen right here. It is fire-and-forget on purpose: the rejection must not wait around
// for the child to actually exit.
function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const force = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
  child.once("exit", () => clearTimeout(force));
  child.kill("SIGTERM");
}

async function startBroker() {
  const port = await freePort();

  const child = spawn("mosquitto", ["-p", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
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
    let settled = false;
    const deadline = Date.now() + START_TIMEOUT_MS;

    const onSpawnError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err.code === "ENOENT") {
        reject(new Error(
          "mosquitto binary not found. Install it (e.g. `brew install mosquitto` on macOS, " +
          "`sudo apt install -y mosquitto` on Debian/Ubuntu) and see test/README.md."
        ));
      } else {
        reject(err);
      }
    };
    const onExit = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`broker exited during startup (code=${code}). output:\n${diag}`));
    };
    function cleanup() {
      child.off("error", onSpawnError);
      child.off("exit", onExit);
    }
    child.on("error", onSpawnError);
    child.on("exit", onExit);

    waitForPort(port, deadline).then(
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        // waitForPort timed out (or otherwise failed) before startBroker() returned a stop
        // handle to the caller, so this is the only place that can clean up the orphaned child.
        killChild(child);
        // Stop reading rather than waiting for the pipes to see EOF: mosquitto itself is a
        // single process, but nothing here guarantees a hung child hasn't forked a subprocess
        // that inherited these fds, which would otherwise hold the pipe open — and with it, the
        // event loop — long after the child we signaled above has exited. diag already has
        // everything captured up to this point, so nothing is lost.
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new Error(`${err.message}. output:\n${diag}`));
      }
    );
  });

  return { port, diagnostics: () => diag, stop: () => stopBroker(child) };
}

function stopBroker(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    killChild(child);
  });
}

module.exports = { startBroker };
