"use strict";
// Two CSEs that have registered with each other, for the test purposes that need one.
//
// TS-0018 marks each test purpose with a test configuration (clause 5.1). CF01 is a single CSE
// with the test system acting as an AE — that is what every other test file here uses. CF04 is
// "between two CSEs, where one CSE is acting as a Test System, the other is SUT", and the whole
// TP/oneM2M/CSE/REG/ family that touches <remoteCSE> sits in CF04. There is no way to exercise
// those against one server.
//
// What this stands up
// -------------------
//   A  IN-CSE  (cse_type 1)  registrar   — CSE-ID /reg-a, <CSEBase> rn "Mobius"
//   B  MN-CSE  (cse_type 2)  registree   — CSE-ID /reg-b, registrar set to A
//
// Both carry the same M2M-SP-ID so that SP-relative addressing (/reg-b/Mobius/...) resolves.
// Each gets a database of its own; the shared mobius4_test would give them one resource tree,
// which is the opposite of the point.
//
// Waiting for the registration
// ----------------------------
// mobius4.js calls registree() without awaiting it and then sends 'ready' (mobius4.js:40-48),
// so startServer() resolving tells us nothing about whether the registration finished. We poll
// A until the <remoteCSE> for B is there.
//
// The poll runs as B — not as A's admin. A <remoteCSE> created by a registering CSE has no acpi,
// so the default access policy makes it visible to its creator only, and A's own admin cannot
// see it (measured 2026-08-08; BACKLOG-066). Polling as A's admin would wait out the timeout on
// a registration that had in fact succeeded.

const { Client } = require("pg");
const config = require("config");
const { startServer, freePort } = require("./server");
const { discover, urils, retrieve, CSE_BASE } = require("./onem2m");

const SP_ID = "//two-cse.test";
const A = { dbName: "mobius4_test_reg_a", cseId: "/reg-a", csebaseRn: CSE_BASE, cseType: 1 };
const B = { dbName: "mobius4_test_reg_b", cseId: "/reg-b", csebaseRn: CSE_BASE, cseType: 2 };

const REGISTRATION_TIMEOUT_MS = 20000;
const REGISTRATION_POLL_MS = 200;

async function withPostgres(fn) {
  const client = new Client({
    host: config.get("db.host"),
    port: config.get("db.port"),
    user: config.get("db.user"),
    password: config.get("db.pw"),
    database: "postgres",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function recreateDatabases() {
  await withPostgres(async (c) => {
    for (const { dbName } of [A, B]) {
      await c.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await c.query(`CREATE DATABASE ${dbName}`);
    }
  });
}

async function dropDatabases() {
  await withPostgres(async (c) => {
    for (const { dbName } of [A, B]) await c.query(`DROP DATABASE IF EXISTS ${dbName}`);
  });
}

// Resolves to the structured id of B's <remoteCSE> on A, or throws with what it did see.
async function waitForRegistration(aBaseUrl, registreeCseId) {
  const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
  let last = "no response yet";
  for (;;) {
    const res = await discover(aBaseUrl, CSE_BASE, { ty: "16" }, { originator: registreeCseId });
    const found = urils(res);
    if (found.length > 0) {
      // Confirm it is B's and not some leftover: read it and check the CSE-ID.
      for (const sid of found) {
        const got = await retrieve(aBaseUrl, sid, { originator: registreeCseId });
        if (got.body && got.body["m2m:csr"] && got.body["m2m:csr"].csi === registreeCseId) return sid;
      }
      last = `found ty=16 at ${found.join(", ")} but none with csi=${registreeCseId}`;
    } else {
      last = `discovery rsc=${res.rsc}, no ty=16 under ${CSE_BASE}`;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `CSE registration did not complete in ${REGISTRATION_TIMEOUT_MS}ms (${last})`
      );
    }
    await new Promise((r) => setTimeout(r, REGISTRATION_POLL_MS));
  }
}

// Starts A, then B pointed at A, and waits until B is registered.
//
// Order matters: registree() fires once at B's startup and is not retried, so A has to be
// listening first or the registration is simply lost.
async function startTwoCSEs({ logLevel = "error" } = {}) {
  await recreateDatabases();

  const aPort = await freePort();
  const bPort = await freePort();
  const aPoa = `http://127.0.0.1:${aPort}`;
  const bPoa = `http://127.0.0.1:${bPort}`;

  const started = [];
  const stopAll = async () => {
    for (const s of started.reverse()) await s.stop();
  };

  try {
    const a = await startServer({
      port: aPort,
      dbName: A.dbName,
      logLevel,
      cse: {
        cse_type: A.cseType,
        sp_id: SP_ID,
        cse_id: A.cseId,
        csebase_rn: A.csebaseRn,
        poa: [aPoa],
      },
    });
    started.push(a);

    const b = await startServer({
      port: bPort,
      dbName: B.dbName,
      logLevel,
      cse: {
        cse_type: B.cseType,
        sp_id: SP_ID,
        cse_id: B.cseId,
        csebase_rn: B.csebaseRn,
        poa: [bPoa],
        registrar: {
          cse_type: A.cseType,
          cse_id: A.cseId,
          csebase_rn: A.csebaseRn,
          ip: "127.0.0.1",
          port: aPort,
          versions: ["4", "3", "2a", "2", "1"],
        },
      },
    });
    started.push(b);

    let remoteCseSid;
    try {
      remoteCseSid = await waitForRegistration(a.baseUrl, B.cseId);
    } catch (err) {
      err.message += `\n--- A output ---\n${a.diagnostics()}\n--- B output ---\n${b.diagnostics()}`;
      throw err;
    }

    return {
      a: { ...a, cseId: A.cseId, csebaseRn: A.csebaseRn, poa: aPoa },
      b: { ...b, cseId: B.cseId, csebaseRn: B.csebaseRn, poa: bPoa },
      spId: SP_ID,
      // Where B's <remoteCSE> lives on A — the target for the CF04 RETRIEVE/UPDATE/DELETE TPs.
      remoteCseSid,
      stop: async () => {
        await stopAll();
        await dropDatabases();
      },
    };
  } catch (err) {
    await stopAll();
    throw err;
  }
}

module.exports = { startTwoCSEs, SP_ID, A, B };
