"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, discover, urils, createRoot, uniqueRn, CSE_BASE, remove } = require("./helpers/onem2m");

let srv, root, c1, g1, cinRn, c1Ri;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "disc");
  // A three-level tree: root / c1 / g1 / <cin>
  c1 = uniqueRn("c1");
  const c1Res = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: c1, lbl: ["depth1"] } });
  c1Ri = c1Res.body["m2m:cnt"].ri; // for the unstructured (ri) addressing test
  g1 = uniqueRn("g1");
  await create(srv.baseUrl, `${root.sid}/${c1}`, 3, { "m2m:cnt": { rn: g1 } });
  const cin = await create(srv.baseUrl, `${root.sid}/${c1}/${g1}`, 4, { "m2m:cin": { con: { v: 1 } } });
  cinRn = cin.body["m2m:cin"].rn;
});

after(async () => { if (root) await root.remove(); if (srv) await srv.stop(); });

test("fu=1 baseline — returns the entire subtree", async () => {
  const res = await discover(srv.baseUrl, root.sid);
  assert.equal(res.rsc, "2000");
  const list = urils(res);
  assert.equal(list.length, 3, `expected 3, actual ${list.length}: ${JSON.stringify(list)}`);
  assert.ok(list.includes(`${root.sid}/${c1}`));
  assert.ok(list.includes(`${root.sid}/${c1}/${g1}`));
  assert.ok(list.includes(`${root.sid}/${c1}/${g1}/${cinRn}`));
});

test("the ty filter narrows results by resource type", async () => {
  const cnts = urils(await discover(srv.baseUrl, root.sid, { ty: "3" }));
  assert.deepEqual(cnts.sort(), [`${root.sid}/${c1}`, `${root.sid}/${c1}/${g1}`].sort());
  const cins = urils(await discover(srv.baseUrl, root.sid, { ty: "4" }));
  assert.deepEqual(cins, [`${root.sid}/${c1}/${g1}/${cinRn}`]);
});

test("the lbl filter narrows results by label", async () => {
  const list = urils(await discover(srv.baseUrl, root.sid, { lbl: "depth1" }));
  assert.deepEqual(list, [`${root.sid}/${c1}`]);
});

test("cra/crb accept the YYYYMMDDThhmmss timestamp format", async () => {
  // Only the form without colons or a trailing Z is accepted (see the report's reference
  // section). With a cutoff in the past, cra should let everything through, while crb at the
  // same instant should let nothing through.
  const after2020 = await discover(srv.baseUrl, root.sid, { cra: "20200101T000000" });
  assert.equal(after2020.rsc, "2000");
  assert.equal(urils(after2020).length, 3);

  const before2020 = await discover(srv.baseUrl, root.sid, { crb: "20200101T000000" });
  assert.equal(before2020.rsc, "2000");
  assert.equal(urils(before2020).length, 0);
});

test("with no lvl given, results span the full depth (regression guard)", async () => {
  // The lvl fix must not change the default behavior. This test has to pass both before and
  // after the fix.
  const list = urils(await discover(srv.baseUrl, root.sid));
  assert.equal(list.length, 3);
});

test("lvl=1 -> returns direct children only", async () => {
  // Implemented — lvl is parsed and validated, then applied to the WHERE clause (converted
  // into an sid depth). 2026-07-26: confirmed that an RSC 2000 response returns only the
  // direct child (c1).
  const list = urils(await discover(srv.baseUrl, root.sid, { lvl: "1" }));
  assert.deepEqual(list, [`${root.sid}/${c1}`]);
});

test("lvl=2 -> returns results down to the second level", async () => {
  const list = urils(await discover(srv.baseUrl, root.sid, { lvl: "2" }));
  assert.deepEqual(
    list.sort(),
    [`${root.sid}/${c1}`, `${root.sid}/${c1}/${g1}`].sort()
  );
});

test("lvl is depth relative to the target (measured from a lower node)", async () => {
  // TS-0001:8.1.2 — the target itself is level 0 and its direct children are level 1.
  // An implementation that wrongly uses absolute depth happens to be right only at the top of
  // the tree, and gets this case wrong.
  const list = urils(await discover(srv.baseUrl, `${root.sid}/${c1}`, { lvl: "1" }));
  assert.deepEqual(list, [`${root.sid}/${c1}/${g1}`]);
});

test("lvl=1 -> addressing by unstructured ID (ri) behaves the same as by structured path", async () => {
  // Regression guard for Finding 1: if target_lvl is computed from req_prim.to (the value
  // used for addressing) instead of req_prim.sid (always the real absolute depth), then when
  // addressing by ri the depth of to (1) differs from the actual sid depth (3), the upper
  // bound comes out too small, and the direct children drop out entirely (RSC 2000 plus an
  // empty list — exactly the silent omission this feature is meant to eliminate). Retrieving
  // c1 by ri must yield the same direct child g1 as retrieving it by structured path
  // (`${root.sid}/${c1}`).
  const list = urils(await discover(srv.baseUrl, c1Ri, { lvl: "1" }));
  assert.deepEqual(list, [`${root.sid}/${c1}/${g1}`]);
});

test("lvl and ty combine with AND", async () => {
  // Do not use the lvl=2 + ty=3 combination — in this tree the only ty=3 (cnt) resources are
  // c1 (level 1) and g1 (level 2), so even if lvl were ignored (the bug), the result of the
  // ty filter alone would coincidentally equal the expected value and the defect would go
  // undetected (measured 2026-07-25: observed as ok # TODO — the assertion failed to catch
  // the defect, which is the brief's "if it's ok, that's a problem" warning, so it was
  // corrected to lvl=1). With lvl=1 + ty=3 the right answer is c1 alone, whereas dropping
  // lvl yields all of ty=3 (c1, g1) and the results genuinely diverge.
  const list = urils(await discover(srv.baseUrl, root.sid, { lvl: "1", ty: "3" }));
  assert.deepEqual(list, [`${root.sid}/${c1}`]);
});

test("an unsupported gmty must not leak resources outside the target subtree", async () => {
    // If set_where_clause breaks its contract in the geo branch and returns only where, then
    // where becomes undefined at the call site and the sid scope restriction disappears with
    // it -> the whole table is returned. This test looks only at whether the scope holds
    // (the error code is covered by a separate test below).
    const outsider = uniqueRn("outsider");
    await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: outsider } });
    try {
        const res = await discover(srv.baseUrl, root.sid, { gmty: "9", gsf: "1", geom: "[1,2]" });
        const leaked = urils(res).filter((u) => !u.startsWith(`${root.sid}/`) && u !== root.sid);
        assert.deepEqual(leaked, [], `resources outside the target were returned: ${JSON.stringify(leaked)}`);
    } finally {
        await remove(srv.baseUrl, `${CSE_BASE}/${outsider}`);
    }
});

test("gmty out of range gives 4000; spec-valid but unimplemented gives 5001", async () => {
    // TS-0004:6.3.4.2.74 — the valid geometryType values are 1..6. mobius4 implements only
    // 1..3. Out of range (9) is a bad request, while 4 (MultiPoint) is valid but
    // unimplemented.
    const bad = await discover(srv.baseUrl, root.sid, { gmty: "9", gsf: "1", geom: "[1,2]" });
    assert.equal(bad.rsc, "4000", `an out-of-range gmty should give 4000. actual ${bad.rsc}`);

    const unimpl = await discover(srv.baseUrl, root.sid, { gmty: "4", gsf: "1", geom: "[1,2]" });
    assert.equal(unimpl.rsc, "5001", `an unimplemented gmty should give 5001. actual ${unimpl.rsc}`);
});

test("a discovery failure is never disguised as 2000", async () => {
    // If the exception is swallowed the result becomes an empty list plus 2000, which is
    // indistinguishable from "no results".
    const res = await discover(srv.baseUrl, root.sid, { gmty: "5", gsf: "1", geom: "[1,2]" });
    assert.notEqual(res.rsc, "2000", "a failure was disguised as a success");
    assert.equal(res.rsc, "5001");
});

test("an underscore in a name does not drag in sibling resources (discovery)", async () => {
    // In LIKE, '_' matches any single character. Without escaping, a query for 'a_c' also
    // matches the descendants of 'abc'. Underscores are common in practice because the Part 3
    // standard names entity instance containers in the form
    // '{modelId}_{version}_{instanceId}'.
    const tag = uniqueRn("t").slice(-6);          // a common tail shared by both names
    const under = `a_c-${tag}`;                    // contains an underscore
    const other = `abc-${tag}`;                    // same length, 'b' where the underscore is
    await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: under } });
    await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: other } });
    await create(srv.baseUrl, `${root.sid}/${other}`, 4, { "m2m:cin": { con: { v: "sibling-owned" } } });

    const list = urils(await discover(srv.baseUrl, `${root.sid}/${under}`));
    assert.deepEqual(list, [], `a sibling's descendants leaked into the underscore-name query: ${JSON.stringify(list)}`);
});
