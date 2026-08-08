"use strict";
// What the container's environment turns into — docker/node-config.js.
//
// NODE_CONFIG is merged *over* config/default.json, so the difference between "not set" and
// "set to nothing" is the difference between keeping a default and destroying it. Every test
// here is about that boundary.
//
// The registrar block is the reason this file exists. cse/registree.js reads
// config.cse.registrar to find the CSE it should register with, and the entrypoint's assembled
// NODE_CONFIG had no such block at all — while also overwriting process.env.NODE_CONFIG, so it
// could not be injected from outside either. A containerised MN-CSE therefore had no way to
// reach a registrar, and the two-CSE work had to run from source instead (found 2026-08-08).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildNodeConfig, only } = require("../docker/node-config");

// The three readers entrypoint.js supplies, with the same blank-is-absent rule: docker-compose
// passes `FOO: ${FOO:-}`, so an unset variable arrives as an empty string rather than not
// arriving at all.
function readers(vars) {
  const env = (name) => {
    const v = vars[name];
    return v === undefined || String(v).trim() === "" ? undefined : String(v).trim();
  };
  const number = (name) => (env(name) === undefined ? undefined : Number(env(name)));
  const bool = (name) => {
    const v = env(name);
    if (v === undefined) return undefined;
    return ["true", "1", "yes", "on"].includes(v.toLowerCase());
  };
  return { env, bool, number };
}

const build = (vars, admin = "Sadmin") => buildNodeConfig(readers(vars), admin);

test("an unconfigured container gets no registrar block at all", () => {
  const cfg = build({});

  assert.equal("registrar" in cfg.cse, false,
    "an empty registrar block would override config/default.json's with nothing");
  assert.equal("cse_type" in cfg.cse, false);
  assert.equal(cfg.cse.admin, "Sadmin");
});

test("blank variables count as unset, not as empty values", () => {
  // This is what an unset variable in .env actually looks like by the time it reaches here.
  const cfg = build({ CSE_TYPE: "", REGISTRAR_CSE_ID: "  ", REGISTRAR_HOST: "" });

  assert.equal("registrar" in cfg.cse, false);
  assert.equal("cse_type" in cfg.cse, false);
});

test("a full registrar configuration reaches cse.registrar in the shape registree.js reads", () => {
  // cse/registree.js reads cse_type, cse_id, csebase_rn, ip and port off config.cse.registrar.
  const cfg = build({
    CSE_TYPE: "2",
    CSE_ID: "/mn-cse",
    CSE_SP_ID: "//example.test",
    REGISTRAR_CSE_ID: "/in-cse",
    REGISTRAR_CSE_BASE_RN: "Mobius",
    REGISTRAR_HOST: "in-cse",
    REGISTRAR_PORT: "7579",
    REGISTRAR_CSE_TYPE: "1",
  });

  assert.equal(cfg.cse.cse_type, 2, "mobius4.js only calls registree() for cse_type 2 or 3");
  assert.deepEqual(cfg.cse.registrar, {
    cse_type: 1,
    cse_id: "/in-cse",
    csebase_rn: "Mobius",
    ip: "in-cse",
    port: 7579,
  });
});

test("a partly configured registrar keeps only what was given", () => {
  // The rest falls through to config/default.json, which is the point of dropping undefined
  // rather than writing nulls.
  const cfg = build({ CSE_TYPE: "2", REGISTRAR_HOST: "in-cse", REGISTRAR_PORT: "7579" });

  assert.deepEqual(cfg.cse.registrar, { ip: "in-cse", port: 7579 });
});

test("numeric variables arrive as numbers", () => {
  // config.get('cse.registrar.port') feeds a URL and a cse_type comparison against 2 and 3;
  // the string "2" is not === 2, and that comparison is what decides whether the CSE registers
  // at all.
  const cfg = build({ CSE_TYPE: "3", REGISTRAR_PORT: "7579", REGISTRAR_CSE_TYPE: "1" });

  assert.equal(typeof cfg.cse.cse_type, "number");
  assert.equal(typeof cfg.cse.registrar.port, "number");
  assert.equal(typeof cfg.cse.registrar.cse_type, "number");
});

test("only() drops a nested block whose every value is unset", () => {
  assert.deepEqual(only({ a: { b: undefined }, c: 1 }), { c: 1 });
  assert.deepEqual(only({ a: { b: { c: undefined } } }), {});
  // An array is a value, not a block to recurse into.
  assert.deepEqual(only({ poa: ["http://x"] }), { poa: ["http://x"] });
});

test("settings unrelated to registration are unaffected", () => {
  const cfg = build({ HTTP_PORT: "7599", DB_NAME: "mobius4", MQTT_ENABLED: "false" });

  assert.equal(cfg.http.port, 7599);
  assert.equal(cfg.db.name, "mobius4");
  assert.equal(cfg.mqtt.enabled, false, "false must survive; it is a value, not an absence");
  // Containers always log to stdout — this one is not driven by an environment variable.
  assert.equal(cfg.logging.file.enabled, false);
});
