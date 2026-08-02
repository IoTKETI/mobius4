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
const { freePort, killChild } = require("./server");

const START_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 50;

// Diagnostic buffer cap — keep only the last ~64KB so a chatty broker cannot grow it without
// bound.
const DIAG_BUFFER_MAX = 64 * 1024;

// Poll a raw TCP connect until it succeeds instead of resolving on a fixed delay — mosquitto
// with no config file (local-only mode, anonymous connections allowed) starts in well under a
// second, but a fixed sleep is exactly the kind of flakiness that erodes trust in a suite.
//
// Returns { promise, cancel } rather than a bare Promise: a plain Promise has no way to stop
// the `attempt` retry loop from the outside. Previously the loop kept re-arming
// setTimeout(attempt, POLL_INTERVAL_MS) — and, mid-attempt, holding an open connecting
// socket — all the way to `deadline` regardless of what the caller did with the settled
// Promise. startBroker()'s onSpawnError/onExit handlers only stopped the *result* of this
// function being used (via their own `settled` flag); they never told this loop to stop
// running. With mosquitto absent, that left a `setTimeout`/`net.connect` chain alive against a
// port nothing will ever open, holding the event loop for the remaining ~10s of
// START_TIMEOUT_MS after the rejection had already been delivered. cancel() stops the timer
// and destroys any in-flight connecting socket so all three startup-failure paths in
// startBroker() can shut this down immediately.
function waitForPort(port, deadline) {
  let timer = null;
  let socket = null;
  let cancelled = false;

  const promise = new Promise((resolve, reject) => {
    (function attempt() {
      if (cancelled) return;
      socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (cancelled) return;
        if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for broker to accept connections on port ${port}`));
        } else {
          timer = setTimeout(attempt, POLL_INTERVAL_MS);
        }
      });
    })();
  });

  function cancel() {
    cancelled = true;
    if (timer) clearTimeout(timer);
    if (socket) socket.destroy();
  }

  return { promise, cancel };
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
    const waiter = waitForPort(port, deadline);

    function cleanup() {
      child.off("error", onSpawnError);
      child.off("exit", onExit);
    }

    // Shared by all three startup-failure paths (spawn error, exit-during-startup, and
    // waitForPort itself timing out): cancel the port-poll loop (which also destroys its
    // in-flight connecting socket), kill the child if it is still alive, and stop reading its
    // pipes. Previously only the waitForPort-rejection path did any of this, so the
    // ENOENT and exit-during-startup paths left waitForPort's retry loop running against a
    // child that was already gone, holding the event loop for the rest of START_TIMEOUT_MS.
    //
    // Stop reading the pipes rather than waiting for them to see EOF: mosquitto itself is a
    // single process, but nothing here guarantees a hung child hasn't forked a subprocess that
    // inherited these fds, which would otherwise hold the pipe open — and with it, the event
    // loop — long after the child we signaled above has exited. diag already has everything
    // captured up to this point, so nothing is lost.
    function teardownOnFailure() {
      waiter.cancel();
      killChild(child);
      child.stdout.destroy();
      child.stderr.destroy();
    }

    const onSpawnError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      teardownOnFailure();
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
      teardownOnFailure();
      reject(new Error(`broker exited during startup (code=${code}). output:\n${diag}`));
    };
    child.on("error", onSpawnError);
    child.on("exit", onExit);

    waiter.promise.then(
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
        teardownOnFailure();
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
