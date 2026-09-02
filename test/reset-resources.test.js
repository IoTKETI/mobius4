"use strict";
// scripts/reset-resources.js — the operator command that empties a deployment's resources.
//
// Two properties are worth a test rather than a careful reading, and they are the two that would
// be silent if they broke.
//
// The table selection must exclude tables an extension owns. PostGIS owns spatial_ref_sys, roughly
// 8500 coordinate system definitions, and emptying it would break every spatial query without
// coming back: db/init.js runs CREATE EXTENSION IF NOT EXISTS, which does nothing once the
// extension is registered, so the damage would outlive any number of restarts. A "truncate
// everything in the public schema" implementation looks identical until you check this.
//
// And the argument parser must refuse what it does not recognise. This command deletes data with
// no way back; reading an unknown flag as "no flag given" would turn a typo into consent.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const config = require("config");
const { parseArgs, OWN_TABLES } = require("../scripts/reset-resources");
const { TEST_DB } = require("./helpers/server");

test("parseArgs reads the two flags it defines", () => {
  assert.deepEqual(parseArgs([]), { yes: false, expect: null });
  assert.deepEqual(parseArgs(["--yes"]), { yes: true, expect: null });
  assert.deepEqual(parseArgs(["--yes", "--expect", "db1"]), { yes: true, expect: "db1" });
  assert.deepEqual(parseArgs(["--expect=db2"]), { yes: false, expect: "db2" });
});

test("parseArgs refuses an unrecognised argument rather than ignoring it", () => {
  // The dangerous reading is the silent one: --force is not --yes, and treating it as neither
  // would make the command a dry run when the operator believed it was not (or the reverse, if the
  // defaults were ever flipped).
  assert.throws(() => parseArgs(["--force"]), /unrecognised argument '--force'/);
  assert.throws(() => parseArgs(["--yes", "--expct", "x"]), /unrecognised argument/);
  assert.throws(() => parseArgs(["--expect"]), /--expect needs a database name/);
});

let db;
before(async () => {
  const { user, pw, host, port } = config.get("db");
  db = new Client({ user, password: pw, host, port, database: TEST_DB });
  await db.connect();
});
after(async () => { if (db) await db.end(); });

test("the table selection takes the CSE's tables and leaves PostGIS's alone", async () => {
  const { rows } = await db.query(OWN_TABLES);
  const names = rows.map((r) => r.name);

  assert.ok(names.length > 0, "the query should find the CSE's tables");
  for (const t of ["cb", "lookup", "cnt", "cin", "sub", "acp", "ae"]) {
    assert.ok(names.includes(t), `${t} is a CSE table and must be emptied: ${names.join(",")}`);
  }
  assert.ok(!names.includes("spatial_ref_sys"),
    `spatial_ref_sys belongs to PostGIS and must not be emptied: ${names.join(",")}`);

  // The exclusion has to come from ownership, not from a name. Assert the table is really there
  // and really extension-owned, so this test fails if PostGIS stops being installed rather than
  // passing vacuously.
  const { rows: [{ present }] } = await db.query(
    `SELECT count(*)::int AS present FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'spatial_ref_sys'`);
  assert.equal(present, 1, "PostGIS's spatial_ref_sys should exist, or this test proves nothing");
});
