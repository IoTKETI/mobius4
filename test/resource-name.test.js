"use strict";
// resourceName: what characters are accepted, and what the path parser does with them.
//
// Reported by an integrating developer: a resource whose rn begins with "_" is created
// successfully and then answers 4004 to both retrieve and delete. Two separate defects met.
//
// The path parser. TS-0009:6.2.2.1 defines "/_" and "/~" as prefixes of the HTTP path
// component, marking the Absolute and SP-Relative forms of To. bindings/http.js tested for
// them with includes() rather than at the start, so any path holding a segment that begins
// with "_" took the Absolute branch. There the replacement found no "/_/" to act on, and the
// leading slash was never stripped because that happens only in the final branch. To kept its
// leading slash while every sid in the lookup table is stored without one, so the resource
// was unreachable by its hierarchical path -- though still reachable by its unstructured
// resource ID, which is what made the report look so strange.
//
// The validation. TS-0004:6.2.4 gives resourceName an ABNF of its own, resolved through
// 6.2.3: resource-name = 1*unreserved, unreserved = (ALPHA / DIGIT) *(ALPHA / DIGIT / "-" /
// "." / "_"). A leading "_" was never valid. The old pattern allowed it, and also allowed
// "@", which appears in no ABNF.
//
// Both are fixed, and both need covering. Rejecting new names does not help the resources
// already created -- the parser fix is what lets those be deleted, so it is tested against a
// row written straight to the database, the way such a resource exists today.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const config = require("config");
const { startServer, TEST_DB } = require("./helpers/server");
const { create, retrieve, remove, createRoot, uniqueRn, ADMIN } = require("./helpers/onem2m");

let srv, root, db, rootRi;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "rn");

  const { user, pw, host, port } = config.get("db");
  db = new Client({ user, password: pw, host, port, database: TEST_DB });
  await db.connect();
  rootRi = (await db.query("SELECT ri FROM lookup WHERE sid = $1", [root.sid])).rows[0].ri;
});

after(async () => {
  if (db) await db.end();
  if (root) await root.remove();
  if (srv) await srv.stop();
});

// Writes a <container> row straight to the store, bypassing validation. Needed because the
// names under test here can no longer be created through the API — which is the situation a
// deployment upgrading from an earlier version is already in.
async function seedContainer(ri, rn, sid) {
  await db.query(
    "INSERT INTO lookup (ri, ty, rn, sid, lvl, pi, cr, int_cr) VALUES ($1, 3, $2, $3, $4, $5, $6, $6)",
    [ri, rn, sid, sid.split("/").length, rootRi, ADMIN]
  );
  await db.query(
    "INSERT INTO cnt (ri, ty, rn, sid, pi, ct, lt, et, cni, cbs, st, cr, int_cr) " +
    "VALUES ($1, 3, $2, $3, $4, $5, $5, $6, 0, 0, 0, $7, $7)",
    [ri, rn, sid, rootRi, "20260803T000000", "20270803T000000", ADMIN]
  );
}

// ── the ABNF, at create time ──────────────────────────────────────────────────

const REJECTED = [
  ["a leading underscore", "_leading"],
  ["a leading dash", "-leading"],
  ["a leading dot", ".leading"],
  ["an at sign, which is in neither ABNF", "with@at"],
];

for (const [label, base] of REJECTED) {
  test(`create is refused with 4000 for ${label}`, async () => {
    const rn = `${base}${uniqueRn("")}`;
    const res = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
    assert.equal(res.rsc, "4000", `expected BAD_REQUEST, got ${res.rsc}: ${res.raw.slice(0, 200)}`);

    // And nothing was left behind — a name refused by validation must not reach the store.
    const after_create = await retrieve(srv.baseUrl, `${root.sid}/${rn}`);
    assert.equal(after_create.rsc, "4004");
  });
}

const ACCEPTED = [
  ["an underscore after the first character", "mid_dle"],
  ["a trailing underscore", "trailing_"],
  ["a dash and a dot inside the name", "a-b.c"],
  ["a leading digit", "9lives"],
];

for (const [label, base] of ACCEPTED) {
  test(`create succeeds, and the resource round-trips, with ${label}`, async () => {
    const rn = `${base}${uniqueRn("")}`;
    const sid = `${root.sid}/${rn}`;

    const c = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
    assert.equal(c.rsc, "2001", `${rn} is valid per the ABNF: ${c.raw.slice(0, 200)}`);

    const r = await retrieve(srv.baseUrl, sid);
    assert.equal(r.rsc, "2000", "a created resource must be reachable by its hierarchical path");
    assert.equal(r.body["m2m:cnt"].rn, rn);

    const d = await remove(srv.baseUrl, sid);
    assert.equal(d.rsc, "2002");
  });
}

// ── the path parser, against a resource that already exists ───────────────────

test("a resource stored with a leading underscore can still be retrieved and deleted", async () => {
  // Written straight to the database because validation now refuses to create one. This is
  // the state a deployment upgrading from an earlier version is in: the names are already
  // there, and refusing new ones does nothing for them. Without the prefix fix in
  // bindings/http.js both operations below answer 4004 and the resource cannot be removed
  // by any client that addresses it hierarchically.
  const rn = "_legacy";
  const ri = `lg${Date.now().toString(36)}`;
  const sid = `${root.sid}/${rn}`;
  await seedContainer(ri, rn, sid);

  try {
    const r = await retrieve(srv.baseUrl, sid);
    assert.equal(r.rsc, "2000", `the stored resource should be readable: ${r.raw.slice(0, 200)}`);

    const d = await remove(srv.baseUrl, sid);
    assert.equal(d.rsc, "2002", "and removable, so a deployment can clean these up");

    const after_del = await retrieve(srv.baseUrl, sid);
    assert.equal(after_del.rsc, "4004");
  } finally {
    await db.query("DELETE FROM lookup WHERE ri = $1", [ri]);
    await db.query("DELETE FROM cnt WHERE ri = $1", [ri]);
  }
});

test("a stored leading-underscore name resolves through every To form, not just CSE-Relative", async () => {
  // Where the two defects actually met. "/~" and "/_" mark the SP-Relative and Absolute
  // forms of To (TS-0009:6.2.2.1) and are prefixes; a name beginning with "_" put a second,
  // meaningless "/_" further along the path. Matching with includes() made every one of
  // these forms take the Absolute branch, where the replacement had nothing to act on and
  // the leading slash survived — so all three failed, not only the plain one. The general
  // form-by-form coverage is in test/addressing.test.js; this is the interaction.
  const SP_ID = config.get("cse.sp_id");
  const CSE_ID = config.get("cse.cse_id");

  const rn = "_legacy2";
  const ri = `lg2${Date.now().toString(36)}`;
  const sid = `${root.sid}/${rn}`;
  await seedContainer(ri, rn, sid);

  try {
    for (const [label, to] of [
      ["CSE-Relative", sid],
      ["SP-Relative", `~${CSE_ID}/${sid}`],
      ["Absolute", `_${SP_ID.slice(1)}${CSE_ID}/${sid}`],
    ]) {
      const res = await retrieve(srv.baseUrl, to);
      assert.equal(res.rsc, "2000", `${label} should resolve: ${res.raw.slice(0, 200)}`);
      assert.equal(res.body["m2m:cnt"].rn, rn);
    }
  } finally {
    await db.query("DELETE FROM lookup WHERE ri = $1", [ri]);
    await db.query("DELETE FROM cnt WHERE ri = $1", [ri]);
  }
});
