"use strict";
// config/validate.js — the startup guard on the admin identity.
//
// The guard exists because cse.admin grants unconditional access: cse/hostingCSE.js returns
// "granted" for any request whose From parameter matches it, before any <accessControlPolicy>
// is consulted, over plain HTTP as much as over TLS. A guessable value is therefore a full
// bypass, and versions up to v4.5.1 shipped one ("SM").
//
// The guard calls process.exit(1), so each case runs in its own child process and the exit
// code is the assertion. Running it in-process would take the test runner down with it.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");

// Runs the guard with the given NODE_CONFIG and reports how it ended.
// Console logging is left on so that the message can be asserted, not just the exit code — a
// guard that refuses for the wrong reason is as bad as one that does not refuse.
function runGuard(overrides) {
  const merged = { logging: { level: "info", file: { enabled: false } }, ...overrides };
  const result = spawnSync(
    process.execPath,
    ["-e", "require('./config/validate').validate_config(require('./logger'))"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: "test", NODE_CONFIG: JSON.stringify(merged) },
      encoding: "utf8",
    }
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("refuses to start when cse.admin is the identity shipped up to v4.5.1", () => {
  const { status, output } = runGuard({ cse: { admin: "SM" } });
  assert.equal(status, 1, "a published admin identity must stop startup");
  assert.match(output, /SM/);
  assert.match(output, /shipped as the default/i, "the message must say why it is refused");
});

test("refuses to start when cse.admin is unset", () => {
  // config/default.json deliberately carries no admin identity since v4.6.0, so an operator
  // who never sets one gets stopped rather than inheriting a value from us.
  const { status, output } = runGuard({});
  assert.equal(status, 1);
  assert.match(output, /not set/i);
});

test("refuses to start when cse.admin is blank", () => {
  const { status } = runGuard({ cse: { admin: "   " } });
  assert.equal(status, 1, "whitespace is not an identity");
});

test("starts, but warns, when cse.admin is the placeholder from local.json.example", () => {
  // Not refused: it never shipped as a default, so no existing deployment runs it. Warned:
  // it is printed in this repository, so a deployment that copied the example verbatim has a
  // published admin identity.
  const { status, output } = runGuard({ cse: { admin: "Superuser" } });
  assert.equal(status, 0, "the example placeholder must not block startup");
  assert.match(output, /placeholder/i);
});

test("starts silently when cse.admin is unique to the deployment", () => {
  const { status, output } = runGuard({ cse: { admin: "an-identity-only-we-know" } });
  assert.equal(status, 0);
  assert.doesNotMatch(output, /placeholder|shipped as the default/i,
    "a properly configured deployment should get no admin warning at all");
});
