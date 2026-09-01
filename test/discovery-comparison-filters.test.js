"use strict";
// The ten value-comparison filterCriteria conditions of discovery.
//
// These are the same ten condition tags as eventNotificationCriteria's, with the same meanings
// (TS-0001:9.6.8 table 9.6.8-3 for the notification side, TS-0004:6.3.5.8 for filterCriteria), so
// cse/enc-conditions.js states the direction once and both paths read it. Written out by hand in
// each place, they had drifted:
//
//   - modifiedSince and unmodifiedSince were swapped, so a discovery returned exactly the opposite
//     set from the one asked for, with RSC 2000 and no sign anything was wrong.
//   - sizeAbove was exclusive where the clause says "equal to or greater than".
//   - sizeAbove/sizeBelow filtered on a column named `sz`, which no model has -- contentSize is
//     `cs` -- and were refused by the request schema before that code could ever run.
//   - stateTagSmaller/stateTagBigger were sent to every resource type, including the ones with no
//     stateTag column, and answered 5000.
//
// All four survived because the only test this file replaces covered cra/crb.
//
// TS-0018 gives one relevant test purpose, TP/oneM2M/CSE/DIS/008, which checks that a *conflicting*
// pair of conditions still gets a success response; it expands to _CRB/CRA, _MS/US, _STS/STB and
// _EXB/EXA. It says nothing about directions, and sizeAbove/sizeBelow have no DIS test purpose at
// all. The direction tests below are therefore derived and marked TS-0018에 해당 TP 없음.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, discover, urils, createRoot, uniqueRn } = require("./helpers/onem2m");

let srv, root, cntSid, cinSid, cs;

const PAST = "20200101T000000";
const FUTURE = "20990101T000000";

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "dcmp");
  const cnt = uniqueRn("c");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: cnt } });
  cntSid = `${root.sid}/${cnt}`;
  const cin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: "abcdefghij" } });
  assert.equal(cin.rsc, "2001", `setup failed: ${cin.raw.slice(0, 160)}`);
  cinSid = `${cntSid}/${cin.body["m2m:cin"].rn}`;
  cs = cin.body["m2m:cin"].cs;
  assert.equal(typeof cs, "number", "the <cin> should report a contentSize");
});
after(async () => { if (root) await root.remove(); if (srv) await srv.stop(); });

async function found(query) {
  const res = await discover(srv.baseUrl, root.sid, query);
  assert.equal(res.rsc, "2000", `discovery should succeed: ${res.rsc} ${res.raw.slice(0, 160)}`);
  return urils(res);
}

// ---------------------------------------------------------------- directions (derived)

test("modifiedSince matches lastModifiedTime AFTER the value, unmodifiedSince BEFORE it", async () => {
  // TS-0018에 해당 TP 없음. TS-0001:9.6.8 table 9.6.8-3. Everything in this tree was created just
  // now, so a past cutoff and a future cutoff give opposite answers, and swapping the two tags
  // swaps those answers -- which is the state this test was written to end.
  const all = await found({});
  assert.ok(all.length >= 2, `the tree should not be empty: ${JSON.stringify(all)}`);

  assert.deepEqual((await found({ ms: PAST })).sort(), all.sort(),
    "modifiedSince(past): everything was modified after 2020");
  assert.deepEqual(await found({ ms: FUTURE }), [],
    "modifiedSince(future): nothing was modified after 2099");
  assert.deepEqual(await found({ us: PAST }), [],
    "unmodifiedSince(past): nothing was last modified before 2020");
  assert.deepEqual((await found({ us: FUTURE })).sort(), all.sort(),
    "unmodifiedSince(future): everything was last modified before 2099");
});

test("createdAfter / createdBefore keep their directions", async () => {
  // TS-0018에 해당 TP 없음. Regression guard: these two were the only ones with a test, and the
  // rewrite must not break what already worked.
  const all = await found({});
  assert.deepEqual((await found({ cra: PAST })).sort(), all.sort());
  assert.deepEqual(await found({ cra: FUTURE }), []);
  assert.deepEqual((await found({ crb: FUTURE })).sort(), all.sort());
  assert.deepEqual(await found({ crb: PAST }), []);
});

test("expireAfter / expireBefore keep their directions", async () => {
  // TS-0018에 해당 TP 없음.
  const all = await found({});
  assert.deepEqual((await found({ exa: PAST })).sort(), all.sort());
  assert.deepEqual(await found({ exb: PAST }), []);
});

// ---------------------------------------------------------------- column-restricted filters

test("stateTag filters answer 2000 instead of 5000, and only reach types that have a stateTag", async () => {
  // TS-0018에 해당 TP 없음. Before this, `sts` sent a stateTag condition to every table in the
  // query, including the ones with no such column, and the discovery failed with 5000 — a filter
  // that crashes rather than filters.
  const wide = await found({ sts: 999 });
  assert.ok(wide.length > 0, `sts=999 should match the resources that have a stateTag: ${JSON.stringify(wide)}`);
  for (const uri of wide) {
    assert.ok(uri === cntSid || uri === cinSid,
      `only <container> and <contentInstance> carry stateTag here, got ${uri}`);
  }
  assert.deepEqual(await found({ stb: 999 }), [], "no stateTag here is bigger than 999");
});

test("sizeAbove and sizeBelow are accepted, filter on contentSize, and sizeAbove is inclusive", async () => {
  // TS-0018에 해당 TP 없음 — sizeAbove/sizeBelow have no DIS test purpose. They were refused 4000
  // by the request schema until now, so the where-clause built for them had never run.
  assert.deepEqual(await found({ sza: cs }), [cinSid],
    `sizeAbove is inclusive, so cs=${cs} must match sza=${cs}`);
  assert.deepEqual(await found({ sza: cs + 1 }), []);
  assert.deepEqual(await found({ szb: cs }), [],
    `sizeBelow is exclusive, so cs=${cs} must not match szb=${cs}`);
  assert.deepEqual(await found({ szb: cs + 1 }), [cinSid]);

  // The <container> has no contentSize -- it has currentByteSize, a different attribute -- so it
  // must not be returned by a contentSize filter that would otherwise match everything.
  const any = await found({ sza: 0 });
  assert.ok(!any.includes(cntSid), `a <container> has no contentSize: ${JSON.stringify(any)}`);
});

test("two column-restricted filters intersect to the types that can carry both", async () => {
  // TS-0018에 해당 TP 없음. stateTag is on <container>/<contentInstance>/<flexContainer> and
  // contentSize on <contentInstance>/<flexContainer>/<timeSeriesInstance>; asking for both can
  // only be answered by the types in the overlap.
  const both = await found({ sts: 999, sza: 0 });
  assert.deepEqual(both, [cinSid],
    `only the <contentInstance> carries both stateTag and contentSize here: ${JSON.stringify(both)}`);
});

// ---------------------------------------------------------------- TS-0018 conflicting pairs

test("TP/oneM2M/CSE/DIS/008_CRB/CRA — a conflicting createdBefore/createdAfter pair still succeeds", async () => {
  // The TP checks the response is a success, not that the list is empty; an unsatisfiable pair
  // legitimately matches nothing.
  const res = await discover(srv.baseUrl, root.sid, { crb: PAST, cra: FUTURE });
  assert.equal(res.rsc, "2000", `should still be a success response: ${res.raw.slice(0, 160)}`);
  assert.deepEqual(urils(res), []);
});

test("TP/oneM2M/CSE/DIS/008_MS/US — a conflicting modifiedSince/unmodifiedSince pair still succeeds", async () => {
  const res = await discover(srv.baseUrl, root.sid, { ms: FUTURE, us: PAST });
  assert.equal(res.rsc, "2000", `should still be a success response: ${res.raw.slice(0, 160)}`);
  assert.deepEqual(urils(res), []);
});

test("TP/oneM2M/CSE/DIS/008_STS/STB — a conflicting stateTagSmaller/stateTagBigger pair still succeeds", async () => {
  const res = await discover(srv.baseUrl, root.sid, { sts: 1, stb: 999 });
  assert.equal(res.rsc, "2000", `should still be a success response: ${res.raw.slice(0, 160)}`);
  assert.deepEqual(urils(res), []);
});

test("TP/oneM2M/CSE/DIS/008_EXB/EXA — a conflicting expireBefore/expireAfter pair still succeeds", async () => {
  const res = await discover(srv.baseUrl, root.sid, { exb: PAST, exa: FUTURE });
  assert.equal(res.rsc, "2000", `should still be a success response: ${res.raw.slice(0, 160)}`);
  assert.deepEqual(urils(res), []);
});
