"use strict";
// docker/entrypoint.js running a command instead of the CSE.
//
// `docker compose run --rm mobius4 scripts/reset-resources.js --yes` has to reach that script with
// the deployment's own configuration. Two things had to be true for that and neither was:
//
//   The entrypoint ignored its arguments entirely. It started a normal CSE, and on a fresh
//   identity volume minted and printed a new administrator identity on the way -- so a mistyped
//   command looked like something far worse than it was.
//
//   The documented way round it, `--entrypoint node`, skips the entrypoint, which is the only
//   thing that turns DB_HOST and its neighbours into NODE_CONFIG. A script needing no
//   configuration was fine; one needing a database read config/default.json and went to localhost.
//
// Both are asserted here by running the real entrypoint as a child process.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const ENTRYPOINT = path.join(REPO, "docker", "entrypoint.js");

// A command that reports what the entrypoint handed it, without needing a database.
function runEntrypoint(args, extraEnv = {}) {
  const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), "m4-entry-"));
  const identityFile = path.join(identityDir, "cse-admin");
  const probe = path.join(identityDir, "probe.js");
  fs.writeFileSync(probe, `
    console.log(JSON.stringify({
      argv: process.argv.slice(2),
      nodeConfig: process.env.NODE_CONFIG ? JSON.parse(process.env.NODE_CONFIG) : null,
      cwd: process.cwd(),
    }));
    process.exit(Number(process.env.PROBE_EXIT || 0));
  `);

  const res = spawnSync(process.execPath, [ENTRYPOINT, probe, ...args], {
    cwd: REPO, encoding: "utf8",
    env: {
      ...process.env, NODE_CONFIG: undefined, CSE_ADMIN_FILE: identityFile,
      DB_HOST: "db.example", DB_PORT: "6543", DB_NAME: "someDeployment",
      DB_USER: "u", DB_PW: "p", ...extraEnv,
    },
  });
  return { res, identityFile, cleanup: () => fs.rmSync(identityDir, { recursive: true, force: true }) };
}

test("arguments are run as a command, with the deployment's configuration assembled", () => {
  const { res, cleanup } = runEntrypoint(["--yes", "--expect", "someDeployment"]);
  try {
    assert.equal(res.status, 0, `entrypoint failed: ${res.stderr}`);
    const out = JSON.parse(res.stdout.trim().split("\n").pop());

    // The command's own arguments reach it at the positions it expects — process.argv.slice(2)
    // must be its flags, not the script path plus its flags.
    assert.deepEqual(out.argv, ["--yes", "--expect", "someDeployment"]);

    // And the environment's database settings arrived as NODE_CONFIG. Without this the script
    // would read config/default.json and quietly target localhost.
    assert.equal(out.nodeConfig?.db?.host, "db.example");
    assert.equal(out.nodeConfig?.db?.port, 6543);
    assert.equal(out.nodeConfig?.db?.name, "someDeployment");
  } finally { cleanup(); }
});

test("running a command does not mint an administrator identity", () => {
  // The trap this closes: a mistyped `docker run` used to start a CSE and create an identity as a
  // side effect. A command is not a CSE start.
  const { res, identityFile, cleanup } = runEntrypoint([]);
  try {
    assert.equal(res.status, 0, `entrypoint failed: ${res.stderr}`);
    assert.equal(fs.existsSync(identityFile), false,
      "the entrypoint must not create an identity file when it is only running a command");
    assert.ok(!/administrator identity/i.test(res.stdout + res.stderr),
      `nothing should be said about an identity: ${(res.stdout + res.stderr).slice(0, 300)}`);
  } finally { cleanup(); }
});

test("the command's exit code is the container's exit code", () => {
  // A reset that refused has to fail the `docker compose run`, or a script calling it cannot tell.
  const { res, cleanup } = runEntrypoint([], { PROBE_EXIT: "3" });
  try {
    assert.equal(res.status, 3, `expected the child's code to propagate, got ${res.status}`);
  } finally { cleanup(); }
});
