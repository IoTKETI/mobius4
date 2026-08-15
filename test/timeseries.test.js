"use strict";
// <timeSeries> (ty 29) and <timeSeriesInstance> (ty 30), as TS-0001:9.6.36 / 9.6.37 define them.
//
// Test purposes carried over from TS-0018. The identifiers in the test names are the parameterised
// expansions of the DMR group (e.g. TP/oneM2M/CSE/DMR/CRE/001 expands to 001_TS for <timeSeries>).
// Missing-data detection is a separate file: test/missing-data.test.js.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { create, retrieve, update, remove, discover, urils, createRoot, uniqueRn, CSE_BASE } = require("./helpers/onem2m");
const { startServer } = require("./helpers/server");

let srv, base, root;

before(async () => {
  srv = await startServer();
  base = srv.baseUrl;
  root = await createRoot(base, "ts");
});
after(async () => { if (srv) await srv.stop(); });

test("TP/oneM2M/CSE/DMR/CRE/001_TS/CB — create a <timeSeries> under the <CSEBase> and get it back", async () => {
  // TS-0018's real identifiers are parent-qualified (001_TS/AE, 001_TS/AEA, 001_TS/CB,
  // 001_TS/CSR) — there is no 001_TS/CNT, because <container> is not a legal parent in the TP
  // set. So this test targets the <CSEBase> directly rather than the <container> `root` fixture
  // the other tests in this file use, to match a real test purpose.
  const rn = uniqueRn("ts");
  const res = await create(base, CSE_BASE, 29, { "m2m:ts": { rn } });

  assert.equal(res.status, 201);
  const ts = res.body["m2m:ts"];
  assert.equal(ts.ty, 29);
  assert.equal(ts.rn, rn);
  assert.ok(ts.ri);
});

test("a fresh <timeSeries> carries the attributes TS-0001:9.6.36 gives multiplicity 1 — no TP in TS-0018", async () => {
  // cni, cbs, mdd and mdc are multiplicity 1 in the clause, so they are present even when the
  // resource uses neither retention limits nor missing-data detection. mdd defaults to false
  // ("The default value is false") and mdc to 0.
  const rn = uniqueRn("ts");
  const res = await create(base, root.sid, 29, { "m2m:ts": { rn } });
  const ts = res.body["m2m:ts"];

  assert.equal(ts.cni, 0);
  assert.equal(ts.cbs, 0);
  assert.equal(ts.mdd, false);
  assert.equal(ts.mdc, 0);
});

test("TP/oneM2M/CSE/DMR/UPD/001_TS/LBL — update a <timeSeries> attribute", async () => {
  const rn = uniqueRn("ts");
  const created = await create(base, root.sid, 29, { "m2m:ts": { rn } });
  const sid = created.body["m2m:ts"].ri;

  const res = await update(base, sid, { "m2m:ts": { lbl: ["sensor:temp"] } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body["m2m:ts"].lbl, ["sensor:temp"]);
});

test("TP/oneM2M/CSE/DMR/DEL/001_TS — delete a <timeSeries>", async () => {
  const rn = uniqueRn("ts");
  const created = await create(base, root.sid, 29, { "m2m:ts": { rn } });
  const sid = created.body["m2m:ts"].ri;

  assert.equal((await remove(base, sid)).status, 200);
  assert.equal((await retrieve(base, sid)).status, 404);
});

test("no TP in TS-0018 — a <timeSeries> cannot be created under a <contentInstance>", async () => {
  // TS-0001:9.6.36 has no child-resource entry putting <timeSeries> under <contentInstance>.
  const cntRn = uniqueRn("c");
  const cnt = await create(base, root.sid, 3, { "m2m:cnt": { rn: cntRn } });
  const cin = await create(base, cnt.body["m2m:cnt"].ri, 4, { "m2m:cin": { rn: uniqueRn("i"), con: "x" } });

  const res = await create(base, cin.body["m2m:cin"].ri, 29, { "m2m:ts": { rn: uniqueRn("ts") } });
  assert.equal(res.rsc, "4108"); // INVALID_CHILD_RESOURCE_TYPE
  assert.equal(res.status, 403);
});

test("no TP in TS-0018 — TS-0001:9.6.36 marks contentInfo (cnf) WO; an UPDATE carrying it is refused and the stored value is unchanged", async () => {
  // WO (write-once): settable at CREATE, never changed afterwards. ts_update_schema enforces
  // this with cnf: Joi.forbidden(), so the request never reaches the DB write.
  const rn = uniqueRn("ts");
  const created = await create(base, root.sid, 29, { "m2m:ts": { rn, cnf: "text/plain:0" } });
  assert.equal(created.status, 201);
  assert.equal(created.body["m2m:ts"].cnf, "text/plain:0");
  const sid = created.body["m2m:ts"].ri;

  const res = await update(base, sid, { "m2m:ts": { cnf: "application/json:0" } });
  // Empirically: update_a_ts's Joi-failure branch sets rsc to BAD_REQUEST (4000), which
  // bindings/http.js's PUT handler maps to HTTP 400.
  assert.equal(res.status, 400);
  assert.equal(res.rsc, "4000");

  const retrieved = await retrieve(base, sid);
  assert.equal(retrieved.body["m2m:ts"].cnf, "text/plain:0");
});

test("no TP in TS-0018 — TS-0001:9.6.36's attribute table has no stateTag for <timeSeries>; st is absent from create and retrieve responses", async () => {
  // st was wrongly copied from <container>'s attribute table and has since been removed from
  // the model, both DDL files, the Joi schema and the response builder. Assert the key is
  // genuinely missing, not merely falsy, so a reintroduced `st: 0` would still be caught.
  const rn = uniqueRn("ts");
  const created = await create(base, root.sid, 29, { "m2m:ts": { rn } });
  assert.equal(created.status, 201);
  assert.equal(Object.prototype.hasOwnProperty.call(created.body["m2m:ts"], "st"), false);
  const sid = created.body["m2m:ts"].ri;

  const retrieved = await retrieve(base, sid);
  assert.equal(retrieved.status, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(retrieved.body["m2m:ts"], "st"), false);
});

test("no TP in TS-0018 — TS-0001:9.6.36 an explicit 0 for mni/mbs/mia survives at CREATE and UPDATE instead of falling back to the deployment default", async () => {
  // create_a_ts uses `prim_res.mni ?? config.default.timeSeries.mni` (not `||`), so a
  // requested 0 must be stored as 0, not replaced by the deployment default.
  const rn = uniqueRn("ts");
  const created = await create(base, root.sid, 29, { "m2m:ts": { rn, mni: 0, mbs: 0, mia: 0 } });
  assert.equal(created.status, 201);
  const ts = created.body["m2m:ts"];
  assert.equal(ts.mni, 0);
  assert.equal(ts.mbs, 0);
  assert.equal(ts.mia, 0);

  // Update path: start from the deployment default (nothing requested at create) and drive it
  // down to 0 explicitly, the case update_a_ts's `prim_res.mni !== undefined` (not truthy) exists
  // for.
  const rn2 = uniqueRn("ts");
  const created2 = await create(base, root.sid, 29, { "m2m:ts": { rn: rn2 } });
  assert.equal(created2.status, 201);
  assert.notEqual(created2.body["m2m:ts"].mni, 0); // sanity: starts from the non-zero default
  const sid2 = created2.body["m2m:ts"].ri;

  const updated = await update(base, sid2, { "m2m:ts": { mni: 0 } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body["m2m:ts"].mni, 0);
});

test("TP/oneM2M/CSE/DMR/CRE/001_TSI/TS — create a <timeSeriesInstance> under a <timeSeries> and get it back", async () => {
  const ts = await create(base, root.sid, 29, { "m2m:ts": { rn: uniqueRn("ts") } });
  const parent = ts.body["m2m:ts"].ri;

  const res = await create(base, parent, 30, {
    "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T100000", con: "21.5" },
  });

  assert.equal(res.status, 201);
  const tsi = res.body["m2m:tsi"];
  assert.equal(tsi.ty, 30);
  assert.equal(tsi.dgt, "20260815T100000");
  assert.equal(tsi.con, "21.5");
  assert.equal(tsi.cs, 4);  // "21.5" is four bytes
});

test("TS-0001:9.6.37 — dataGenerationTime is unique among siblings (no TP in TS-0018)", async () => {
  const ts = await create(base, root.sid, 29, { "m2m:ts": { rn: uniqueRn("ts") } });
  const parent = ts.body["m2m:ts"].ri;

  const first = await create(base, parent, 30, {
    "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T110000", con: "1" },
  });
  assert.equal(first.status, 201);

  const dup = await create(base, parent, 30, {
    "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T110000", con: "2" },
  });
  assert.equal(dup.status, 409);
});

test("TS-0001:10.2.4.27 — UPDATE on a <timeSeriesInstance> is refused (no matching TP in TS-0018)", async () => {
  // TS-0001:10.2.4.27 — "The Update operation shall not apply to <timeSeriesInstance> resource."
  const ts = await create(base, root.sid, 29, { "m2m:ts": { rn: uniqueRn("ts") } });
  const created = await create(base, ts.body["m2m:ts"].ri, 30, {
    "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T120000", con: "1" },
  });

  const res = await update(base, created.body["m2m:tsi"].ri, { "m2m:tsi": { lbl: ["x"] } });
  // update_a_res's switch has no case 30, so it falls to the default branch, which answers
  // OPERATION_NOT_ALLOWED (4005) -- the same rsc other resource-type-forbidden UPDATEs in this
  // codebase answer (see test/cse-registration.test.js's <CSEBase> UPDATE). bindings/http.js
  // maps 4005 to HTTP 405, not 403 -- 403 is ACCESS_DENIED, a different rsc.
  assert.equal(res.status, 405);
  assert.equal(res.rsc, "4005");
});

test("TS-0001:9.6.36 — maxNrOfInstances evicts the oldest <timeSeriesInstance> (no TP in TS-0018)", async () => {
  const ts = await create(base, root.sid, 29, { "m2m:ts": { rn: uniqueRn("ts"), mni: 2 } });
  const parent = ts.body["m2m:ts"].ri;

  const rns = [];
  for (let i = 0; i < 3; i++) {
    const rn = uniqueRn("i");
    rns.push(rn);
    await create(base, parent, 30, {
      "m2m:tsi": { rn, dgt: `20260815T13000${i}`, con: `${i}` },
    });
  }

  const after = await retrieve(base, parent);
  assert.equal(after.body["m2m:ts"].cni, 2);
});

test("TS-0001:9.6.36 — currentNrOfInstances and currentByteSize track the children (no TP in TS-0018)", async () => {
  const ts = await create(base, root.sid, 29, { "m2m:ts": { rn: uniqueRn("ts") } });
  const parent = ts.body["m2m:ts"].ri;

  await create(base, parent, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T140000", con: "abcd" } });
  await create(base, parent, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T140100", con: "ef" } });

  const after = await retrieve(base, parent);
  assert.equal(after.body["m2m:ts"].cni, 2);
  assert.equal(after.body["m2m:ts"].cbs, 6);
});

test("no TP in TS-0018 — content larger than the parent's maxByteSize is refused, and neither the parent's counters nor the child move (TS-0001:9.6.36, TS-0004:6.6.3.6)", async () => {
  // write_a_tsi's WRITE_TSI_SQL was ported from WRITE_CIN_SQL in cse/resources/cin.js and its
  // $n placeholders were renumbered in the process (<tsi> has no stateTag or
  // accessControlPolicyIDs, so the argument list is shorter than <cin>'s). The refusal guard --
  // `WHERE ri = $1 AND (mbs IS NULL OR $2 <= mbs)` -- is exactly where a placeholder landing on
  // the wrong argument would show up as silently wrong behaviour rather than a thrown error, so
  // this locks in that $1 and $2 still line up with pi and cs.
  const ts = await create(base, root.sid, 29, { "m2m:ts": { rn: uniqueRn("ts"), mbs: 5 } });
  const parent = ts.body["m2m:ts"].ri;

  const before = await retrieve(base, parent);
  assert.equal(before.body["m2m:ts"].cni, 0);
  assert.equal(before.body["m2m:ts"].cbs, 0);

  const oversizedRn = uniqueRn("i");
  const oversized = await create(base, parent, 30, {
    "m2m:tsi": { rn: oversizedRn, dgt: "20260815T150000", con: "y".repeat(50) },
  });
  // Empirically determined, not assumed: create_a_tsi's `!written.stored` branch (cse/resources/
  // tsi.js) sets rsc to NOT_ACCEPTABLE (5207, config/enums.js), and bindings/http.js's POST
  // handler maps 5207 to HTTP 406.
  assert.equal(oversized.status, 406, `expected NOT_ACCEPTABLE: ${oversized.raw.slice(0, 200)}`);
  assert.equal(oversized.rsc, "5207");

  // The refusal must not leave the parent half-updated -- this is the whole reason
  // WRITE_TSI_SQL is a single statement rather than an UPDATE followed by an INSERT.
  const afterRefusal = await retrieve(base, parent);
  assert.equal(afterRefusal.body["m2m:ts"].cni, 0, "a refused create must not move cni");
  assert.equal(afterRefusal.body["m2m:ts"].cbs, 0, "a refused create must not move cbs");

  // And the child itself must not exist.
  const disc = await discover(base, parent, { ty: "30" });
  assert.deepEqual(urils(disc), [], "a refused <tsi> must not be stored");

  // A <tsi> that fits is still accepted, and the counters move for it.
  const fitting = await create(base, parent, 30, {
    "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T150100", con: "ok" },
  });
  assert.equal(fitting.status, 201, `expected CREATED: ${fitting.raw.slice(0, 200)}`);

  const afterFit = await retrieve(base, parent);
  assert.equal(afterFit.body["m2m:ts"].cni, 1);
  assert.equal(afterFit.body["m2m:ts"].cbs, 2);
});

test("TS-0001:9.6.36 — <latest> and <oldest> under a <timeSeries> (no TP in TS-0018)", async () => {
  // Both are multiplicity 1 in the child-resource table, so they are not optional.
  const ts = await create(base, root.sid, 29, { "m2m:ts": { rn: uniqueRn("ts") } });
  const parent = ts.body["m2m:ts"].ri;

  await create(base, parent, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T150000", con: "first" } });
  await create(base, parent, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T150100", con: "last" } });

  const la = await retrieve(base, `${parent}/la`);
  assert.equal(la.status, 200);
  assert.equal(la.body["m2m:tsi"].con, "last");

  const ol = await retrieve(base, `${parent}/ol`);
  assert.equal(ol.status, 200);
  assert.equal(ol.body["m2m:tsi"].con, "first");
});

test("<latest> on an empty <timeSeries> is 4004 (no TP in TS-0018)", async () => {
  const ts = await create(base, root.sid, 29, { "m2m:ts": { rn: uniqueRn("ts") } });
  const res = await retrieve(base, `${ts.body["m2m:ts"].ri}/la`);
  assert.equal(res.status, 404);
});

test("<latest>/<oldest> order by dataGenerationTime, not arrival order (no TP in TS-0018)", async () => {
  // <timeSeries>/<timeSeriesInstance> have no stateTag (TS-0001:9.6.36/9.6.37 give them none),
  // unlike <container>/<contentInstance>. find_edge_tsi orders by dgt, so posting an older dgt
  // last must still surface as <oldest>, not as <latest> because it arrived most recently.
  const ts = await create(base, root.sid, 29, { "m2m:ts": { rn: uniqueRn("ts") } });
  const parent = ts.body["m2m:ts"].ri;

  await create(base, parent, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T160000", con: "middle" } });
  await create(base, parent, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T170000", con: "greatest-dgt" } });
  // Arrives last but carries the smallest dgt of the three.
  await create(base, parent, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T150000", con: "smallest-dgt-arrived-last" } });

  const la = await retrieve(base, `${parent}/la`);
  assert.equal(la.status, 200);
  assert.equal(la.body["m2m:tsi"].con, "greatest-dgt");

  const ol = await retrieve(base, `${parent}/ol`);
  assert.equal(ol.status, 200);
  assert.equal(ol.body["m2m:tsi"].con, "smallest-dgt-arrived-last");
});

test("DELETE <latest> removes the newest <tsi> and shrinks the parent's cni/cbs (no TP in TS-0018)", async () => {
  const ts = await create(base, root.sid, 29, { "m2m:ts": { rn: uniqueRn("ts") } });
  const parent = ts.body["m2m:ts"].ri;

  await create(base, parent, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T180000", con: "ab" } });
  await create(base, parent, 30, { "m2m:tsi": { rn: uniqueRn("i"), dgt: "20260815T180100", con: "cde" } });

  const before = await retrieve(base, parent);
  assert.equal(before.body["m2m:ts"].cni, 2);
  assert.equal(before.body["m2m:ts"].cbs, 5);

  const del = await remove(base, `${parent}/la`);
  assert.equal(del.status, 200);

  const after = await retrieve(base, parent);
  assert.equal(after.body["m2m:ts"].cni, 1, "deleting <latest> must decrement the parent's cni");
  assert.equal(after.body["m2m:ts"].cbs, 2, "deleting <latest> must shrink the parent's cbs by the removed instance's cs");

  // The remaining instance is now both <latest> and <oldest>.
  const la = await retrieve(base, `${parent}/la`);
  assert.equal(la.body["m2m:tsi"].con, "ab");
});
