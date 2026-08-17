"use strict";
// db/migrations/v4.16.0.sql's srt UPDATE (finding 1 from the pre-merge review) -- exercised
// against an isolated database, not the shared test one, the same way test/db-failure.test.js
// keeps its schema-breaking work off the database every other test file shares.
//
// db/init.js's create_cb only runs when no <CSEBase> row exists yet, so config/default.json's
// cse.supported_resource_types (which now lists 29 and 30) only reaches an upgraded deployment's
// <CSEBase> through this migration file, not through the application code every other test in
// this repo exercises. Simulating "a deployment that predates ty 29/30" means writing the row
// directly, then running the actual migration file against it -- not a hand-copied restatement of
// its UPDATE, so this cannot silently drift from what operators actually run.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const config = require("config");
const { startServer } = require("./helpers/server");

const MIGRATION_DB = "mobius4_test_srt_migration";
const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, "..", "db", "migrations", "v4.16.0.sql"),
  "utf8"
);

async function withAdmin(fn) {
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

let db;

before(async () => {
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${MIGRATION_DB}`);
    await c.query(`CREATE DATABASE ${MIGRATION_DB}`);
  });

  // db/init.js builds the schema and the <CSEBase> row on first boot -- including today's srt,
  // which already has 29/30, since this repo's config/default.json ships the fix from the same
  // review round (finding 1's "fresh installs" half). The tests below overwrite srt afterward to
  // simulate the pre-v4.16.0 row this migration exists for.
  const srv = await startServer({ dbName: MIGRATION_DB });
  await srv.stop();

  db = new Client({
    host: config.get("db.host"),
    port: config.get("db.port"),
    user: config.get("db.user"),
    password: config.get("db.pw"),
    database: MIGRATION_DB,
  });
  await db.connect();
});

after(async () => {
  if (db) await db.end();
  await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${MIGRATION_DB}`));
});

test("the v4.16.0 migration adds 29/30 to an existing <CSEBase>'s srt, without disturbing an operator's own additions (finding 1)", async () => {
  // Simulate a deployment that registered before ty 29/30 existed, and that also customised srt
  // with a type of its own (999) -- proving the migration is additive, not a replacement.
  await db.query(`UPDATE cb SET srt = ARRAY[1,2,3,5,999]::INTEGER[] WHERE ty = 5`);

  const before = (await db.query(`SELECT srt FROM cb WHERE ty = 5`)).rows[0].srt;
  assert.ok(!before.includes(29) && !before.includes(30), "fixture setup must actually remove 29/30");

  await db.query(MIGRATION_SQL);

  const { rows } = await db.query(`SELECT srt FROM cb WHERE ty = 5`);
  const srt = rows[0].srt;
  assert.ok(srt.includes(29), `srt must include 29 after the migration: ${JSON.stringify(srt)}`);
  assert.ok(srt.includes(30), `srt must include 30 after the migration: ${JSON.stringify(srt)}`);
  assert.ok(srt.includes(999), `the operator's own addition must survive: ${JSON.stringify(srt)}`);
  for (const ty of [1, 2, 3, 5]) {
    assert.ok(srt.includes(ty), `pre-existing entry ${ty} must survive: ${JSON.stringify(srt)}`);
  }
});

test("re-running the migration is idempotent -- no duplicate 29/30 entries", async () => {
  const before = (await db.query(`SELECT srt FROM cb WHERE ty = 5`)).rows[0].srt;
  assert.ok(before.includes(29) && before.includes(30), "must run after the previous test has already applied the migration once");

  await db.query(MIGRATION_SQL);
  const after_second_run = (await db.query(`SELECT srt FROM cb WHERE ty = 5`)).rows[0].srt;

  assert.deepEqual(
    [...after_second_run].sort((a, b) => a - b),
    [...before].sort((a, b) => a - b),
    "a second run must change nothing once 29/30 are already present"
  );
  const occurrences = after_second_run.filter((v) => v === 29).length;
  assert.equal(occurrences, 1, "29 must not be duplicated by a repeated run");
});

test("the migration also tolerates a partial prior application (only one of 29/30 already present)", async () => {
  // A row that already has 29 (e.g. hand-patched) but not 30 must not end up with 29 twice once
  // the migration adds what is still missing.
  await db.query(`UPDATE cb SET srt = ARRAY[1,2,3,5,29]::INTEGER[] WHERE ty = 5`);

  await db.query(MIGRATION_SQL);

  const { rows } = await db.query(`SELECT srt FROM cb WHERE ty = 5`);
  const srt = rows[0].srt;
  assert.ok(srt.includes(30), `srt must gain the still-missing 30: ${JSON.stringify(srt)}`);
  assert.equal(srt.filter((v) => v === 29).length, 1, "the already-present 29 must not be duplicated");
});
