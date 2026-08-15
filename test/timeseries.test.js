"use strict";
// <timeSeries> (ty 29) and <timeSeriesInstance> (ty 30), as TS-0001:9.6.36 / 9.6.37 define them.
//
// Test purposes carried over from TS-0018. The identifiers in the test names are the parameterised
// expansions of the DMR group (e.g. TP/oneM2M/CSE/DMR/CRE/001 expands to 001_TS for <timeSeries>).
// Missing-data detection is a separate file: test/missing-data.test.js.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { create, retrieve, update, remove, createRoot, uniqueRn, CSE_BASE } = require("./helpers/onem2m");
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
