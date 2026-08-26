"use strict";
// Drops and recreates the shared test database before the suite runs.
//
// The suite used to start from whatever the last run left behind. Each test file creates its own
// root under the <CSEBase> and deletes it afterwards, but that cleanup is best-effort by design:
// delete_a_res removes descendants without awaiting (BACKLOG-014 in mobius4-dev-tool), and
// waitForSubtreeGone in test/helpers/onem2m.js deliberately gives up after five seconds rather
// than failing a test over slow cleanup. Rows therefore accumulate across runs.
//
// That matters because cse.discovery_limit (200 by default) caps how many rows *per type* a
// discovery reads out of the database. A discovery scoped to a resource is unaffected -- the
// subtree condition (`sid LIKE 'target/%'`) is applied in SQL before the limit -- but one aimed
// at the <CSEBase> reads the whole CSE and gets cut. Measured 2026-08-26 on the accumulated
// database: 6804 lookup rows, 1023 <container>, 236 <subscription>, and a <CSEBase>-wide
// discovery returned exactly 200, the cap.
//
// Nothing had failed yet, and the reason is worth writing down because it is luck rather than
// design: since v4.15.1 discovery returns newest-first, so a test's own fresh rows sit at the
// top of the cut. Under the oldest-first ordering that preceded it, the same accumulation would
// have hidden them. A suite whose correctness depends on how many rows a previous run happened
// to leave behind is one that fails on a date nobody can predict, and the failure points at the
// database rather than at the test.
//
// Run from npm pretest, so `npm test` is deterministic. Running a single file directly
// (`node --test test/foo.test.js`) skips this on purpose -- that is the debugging path, and
// wiping the database out from under someone inspecting it would be worse than the accumulation.

const { Client } = require("pg");
const config = require("config");

const TEST_DB = "mobius4_test";

async function withPostgres(fn) {
  const client = new Client({
    host: config.get("db.host"),
    port: config.get("db.port"),
    user: config.get("db.user"),
    password: config.get("db.pw"),
    // Connect to the maintenance database: a database cannot be dropped while it is the one
    // you are connected to.
    database: "postgres",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function main() {
  await withPostgres(async (c) => {
    // A connection still open against the database makes DROP fail with 55006. That is normally
    // a stale server from an interrupted run, and terminating it is what an operator would do by
    // hand; leaving the suite to fail on the drop instead just moves the manual step later.
    await c.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB],
    );
    await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await c.query(`CREATE DATABASE ${TEST_DB}`);

    // Per-run databases from test/helpers/two-cse.js. It drops its own pair in after(), so these
    // exist only when a run was interrupted between create and drop. They are named with a
    // timestamp, so leftovers are never reused and would otherwise sit there forever.
    const { rows } = await c.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'mobius4_test_reg_%'`,
    );
    for (const { datname } of rows) {
      await c.query(`DROP DATABASE IF EXISTS ${datname}`);
    }
    if (rows.length) {
      console.log(`reset-test-db: dropped ${rows.length} leftover two-CSE database(s)`);
    }
  });
  console.log(`reset-test-db: ${TEST_DB} recreated`);
}

main().catch((err) => {
  // Fail loudly: a suite that silently ran against a stale database is the situation this script
  // exists to end.
  console.error(`reset-test-db: ${err.message}`);
  process.exit(1);
});
