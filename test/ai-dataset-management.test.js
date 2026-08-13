"use strict";
// TR-0071 AI/ML dataset management — <mlDatasetPolicy>, <dataset>, <datasetFragment>.
//
// Unlike the model side (test/ai-model-management.test.js), most of the behaviour here is the
// CSE doing work on its own: TR-0071:7.2.3.2 says <dataset> "is created by the
// <mlDatasetPolicy> resource hosting CSE, so the Create procedure is not specified as an API",
// and 7.2.3.3 says the same of <datasetFragment>. So most of these tests assert what the CSE
// produced from a policy, not what a client sent directly — which is also why the fixtures below
// (source <container>s with real <contentInstance>s) matter more than usual.
//
// TS-0018 defines no test purposes for this resource family either (it comes from TR-0071, a
// Technical Report, not a TS) — see test/ai-model-management.test.js's header for the identifier
// convention (TP/TR-0071/CSE/DST/...) and the { todo: true } policy for divergences. Short names
// (dsp/dts/dsf, sri/dst/det/tcst/tcd/nvp/dsfm/hdi/ldi/nrhd/nrld, dspi/lof, dfst/dfet/nrf/dsfr) are
// taken from corpus/symbols/tr-0071.yaml (measured against models/*.js and cse/resources/*.js in
// mobius4-dev-tool on 2026-08-13), not the mocm/most placeholders in the task-12 brief.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, retrieve, update, discover, uniqueRn, urils, CSE_BASE } = require("./helpers/onem2m");
const { startSink } = require("./helpers/noti-sink");

const TY = { CNT: 3, CIN: 4, DSP: 105, DTS: 106, DSF: 107 };

let srv, root;
before(async () => {
  srv = await startServer();
  const rn = uniqueRn("dstroot");
  const res = await create(srv.baseUrl, CSE_BASE, TY.CNT, { "m2m:cnt": { rn } });
  assert.equal(res.rsc, "2001");
  root = { rn, sid: `${CSE_BASE}/${rn}` };
});
after(async () => { if (srv) await srv.stop(); });

/**
 * A source <container> holding one <contentInstance> per value in `values`, oldest first, each
 * with con = the value itself (so it can be a plain object for feature-name extraction). Waits
 * ~1.1s between instances: mobius4's `ct` (config/default.json "timestamp_format":
 * "YYYYMMDDTHHmmss") has only second granularity, and every window/ordering computation in
 * cse/datasetManager.js sorts and filters on `ct` — same-second instances would be indistinguishable.
 */
async function makeSource(name, values) {
  const rn = uniqueRn(name);
  const c = await create(srv.baseUrl, root.sid, TY.CNT, { "m2m:cnt": { rn } });
  assert.equal(c.rsc, "2001");
  const sid = `${root.sid}/${rn}`;
  const cts = [];
  for (const v of values) {
    const res = await create(srv.baseUrl, sid, TY.CIN, { "m2m:cin": { con: v } });
    assert.equal(res.rsc, "2001", `cin create failed: ${res.raw.slice(0, 200)}`);
    cts.push(res.body["m2m:cin"].ct);
    await new Promise((r) => setTimeout(r, 1100));
  }
  return { rn, sid, cts };
}

// <mlDatasetPolicy> is created directly under <CSEBase> — dsp_parent_res_types
// (cse/resources/dsp.js) is ["cb", "ae", "csr"], matching <modelRepo>/<modelDeploymentList> in
// ai-model-management.test.js.
async function makePolicy(extra) {
  const rn = uniqueRn("dsp");
  const res = await create(srv.baseUrl, CSE_BASE, TY.DSP, { "m2m:dsp": { rn, dsfm: 1, ...extra } });
  return { rn, sid: `${CSE_BASE}/${rn}`, res };
}

// A historical <dataset> with exactly one <datasetFragment>, built from a single source
// container with `rows` instances. Returns the sids needed by the tests that only care that a
// fragment exists, not about its exact content.
async function makeDatasetWithFragment(rows = 3) {
  const src = await makeSource("src", Array.from({ length: rows }, (_, i) => ({ v: i })));
  const { sid: dspSid, res } = await makePolicy({ sri: [src.sid], nrhd: 100 });
  assert.equal(res.rsc, "2001", `policy create failed: ${res.raw.slice(0, 200)}`);
  const dsp = res.body["m2m:dsp"];
  assert.ok(dsp.hdi, `historicalDatasetID was not set: ${JSON.stringify(dsp)}`);

  const dtsSid = dsp.hdi;
  const frags = await discover(srv.baseUrl, dtsSid, { ty: String(TY.DSF) });
  const dsfSid = urils(frags)[0];
  assert.ok(dsfSid, `no <datasetFragment> was created under ${dtsSid}: ${frags.raw.slice(0, 200)}`);

  return { dspSid, dtsSid, dsfSid, src };
}

// -------------------------------------------------------------------------------------------

test("TC_TR0071_DST_CRE_001: TP/TR-0071/CSE/DST/CRE/001 — a policy makes the CSE create a <dataset>, not the client", async () => {
  const src = await makeSource("src", [{ x: 1 }, { x: 2 }, { x: 3 }]);
  // TR-0071:7.2.3.2 — "A <dataset> resource is created by the <mlDatasetPolicy> resource hosting
  // CSE, so the Create procedure is not specified as an API."
  const { res } = await makePolicy({ sri: [src.sid], nrhd: 100 });
  assert.equal(res.rsc, "2001", `policy create failed: ${res.raw.slice(0, 200)}`);
  const dsp = res.body["m2m:dsp"];
  assert.ok(dsp.hdi, `historicalDatasetID was not set: ${JSON.stringify(dsp)}`);

  const dts = (await retrieve(srv.baseUrl, dsp.hdi)).body["m2m:dts"];
  assert.ok(dts, "historicalDatasetID did not resolve to a <dataset>");
  assert.equal(dts.ty, TY.DTS);
});

// FAILS 2026-08-13: mobius4 has no `custodian` attribute anywhere in this resource family.
// TR-0071:7.2.3.2 says "the custodian attribute of <dataset> resource is set as the same as
// <mlDatasetPolicy> resource, if present" -- but models/dsp-model.js and models/dts-model.js
// have no `cst` column, and dsp_create_schema (cse/validation/res_schema.js:363-382) is a
// strict Joi object schema with no `cst` key and no `.unknown(true)` (contrast with
// flx_create_schema, which needs one for its open attribute set) -- so a CREATE that includes
// `cst` is rejected outright as an unrecognized key, before custodian propagation could even be
// attempted. features/test-purposes/TR-0071.md TP/TR-0071/CSE/DST/CRE/002 calls this "the test
// itself does not hold" for the same underlying reason; not covered by the revision proposal.
test("TC_TR0071_DST_CRE_002: TP/TR-0071/CSE/DST/CRE/002 — the created <dataset> inherits the policy's custodian", { todo: true }, async () => {
  const src = await makeSource("src", [{ x: 1 }]);
  const { res } = await makePolicy({ sri: [src.sid], nrhd: 100, cst: "CAdmin" });
  assert.equal(res.rsc, "2001", `policy create with custodian failed: ${res.raw.slice(0, 200)}`);
  const dsp = res.body["m2m:dsp"];
  assert.equal(dsp.cst, "CAdmin");

  const dts = (await retrieve(srv.baseUrl, dsp.hdi)).body["m2m:dts"];
  assert.equal(dts.cst, "CAdmin", "the <dataset> should inherit its policy's custodian");
});

test("TC_TR0071_DST_CRE_003: TP/TR-0071/CSE/DST/CRE/003 — historicalDatasetID resolves to a <dataset>", async () => {
  // TR-0071:7.2.2.1 — historicalDatasetID "The ID of the <dataset> resource for a training
  // dataset which gets generated with existing source resources".
  const src = await makeSource("src", [{ x: 1 }, { x: 2 }]);
  const { res } = await makePolicy({ sri: [src.sid], nrhd: 100 });
  assert.equal(res.rsc, "2001");
  const got = await retrieve(srv.baseUrl, res.body["m2m:dsp"].hdi);
  assert.equal(got.rsc, "2000");
  assert.equal(got.body["m2m:dts"].ty, TY.DTS);
});

test("TC_TR0071_DST_CRE_004: TP/TR-0071/CSE/DST/CRE/004 — liveDatasetID resolves to a <dataset>", async () => {
  // TR-0071:7.2.2.1 — liveDatasetID "The ID of the <dataset> resource for a dataset which gets
  // generated with newly created source resources". The TR's own description of this attribute
  // ("When the is numberOfDataForInference set...") names a non-existent attribute -- revision
  // proposal A-6 (docs/tr-0071-revision-proposal.md) identifies this as an editorial error and
  // that the attribute meant is numberOfRowsForLiveDataset (nrld); mobius4 is already built
  // against nrld (cse/resources/dsp.js:67-74).
  const src = await makeSource("src", [{ x: 1 }]);
  const { res } = await makePolicy({ sri: [src.sid], nrld: 1 });
  assert.equal(res.rsc, "2001", `policy create failed: ${res.raw.slice(0, 200)}`);
  const dsp = res.body["m2m:dsp"];
  assert.ok(dsp.ldi, `liveDatasetID was not set: ${JSON.stringify(dsp)}`);

  const got = await retrieve(srv.baseUrl, dsp.ldi);
  assert.equal(got.rsc, "2000");
  assert.equal(got.body["m2m:dts"].ty, TY.DTS);
});

// FAILS 2026-08-13: a client CREATE straight at <dataset> succeeds instead of being rejected.
// TR-0071:7.2.3.2 says the Create procedure for <dataset> "is not specified as an API" -- it is
// only ever created by the hosting CSE, from a policy. But cse/hostingCSE.js's CREATE dispatch
// table (around line 180) lists `case 106: await dts.create_a_dts(...)` next to every other
// client-facing resource type, with a comment admitting "this is not called by client, temporary
// for testing" -- there is no check distinguishing an internal call (from datasetManager.js) from
// an external client request. Any parent that accepts a <dataset> child (dts_parent_res_types =
// ["cb", "ae", "csr"], cse/resources/dts.js:12) will accept a direct client CREATE too. Flagged
// in features/test-purposes/TR-0071.md TP/TR-0071/CSE/DST/CRE/005; not covered by the revision
// proposal.
test("TC_TR0071_DST_CRE_005: TP/TR-0071/CSE/DST/CRE/005 — <dataset> has no client CREATE", { todo: true }, async () => {
  const rn = uniqueRn("dts");
  const res = await create(srv.baseUrl, CSE_BASE, TY.DTS, { "m2m:dts": { rn } });
  assert.notEqual(res.rsc, "2001", `<dataset> accepted a direct client CREATE: ${res.raw.slice(0, 200)}`);
});

// FAILS 2026-08-13: same gap as CRE/005, one level down. TR-0071:7.2.3.3 says <datasetFragment>
// "is created by the <dataset> resource hosting CSE, so the Create procedure is not specified as
// an API." cse/hostingCSE.js's CREATE dispatch has the identical "temporary for testing" case for
// `case 107: await dsf.create_a_dsf(...)`. Flagged in features/test-purposes/TR-0071.md
// TP/TR-0071/CSE/DST/CRE/006; not covered by the revision proposal.
test("TC_TR0071_DST_CRE_006: TP/TR-0071/CSE/DST/CRE/006 — <datasetFragment> has no client CREATE", { todo: true }, async () => {
  const { dtsSid } = await makeDatasetWithFragment();
  const res = await create(srv.baseUrl, dtsSid, TY.DSF,
    { "m2m:dsf": { rn: uniqueRn("dsf"), dsfr: {}, dsfm: 1 } });
  assert.notEqual(res.rsc, "2001", `<datasetFragment> accepted a direct client CREATE: ${res.raw.slice(0, 200)}`);
});

test("TC_TR0071_DST_CRE_007: TP/TR-0071/CSE/DST/CRE/007 — no datasetStartTime/EndTime includes every source instance", async () => {
  // TR-0071:7.2.2.1 — "If datasetStartTime and datasetEndTime both are not provided, then all
  // data instances of source resources get included in the dataset."
  const src = await makeSource("src", [{ v: 0 }, { v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }]);
  const { res } = await makePolicy({ sri: [src.sid], nrhd: 100 }); // no dst/det
  assert.equal(res.rsc, "2001", `policy create failed: ${res.raw.slice(0, 200)}`);
  const dtsSid = res.body["m2m:dsp"].hdi;

  const frags = urils(await discover(srv.baseUrl, dtsSid, { ty: String(TY.DSF) }));
  assert.ok(frags.length > 0, "no <datasetFragment> was created");
  let totalRows = 0;
  for (const f of frags) totalRows += (await retrieve(srv.baseUrl, f)).body["m2m:dsf"].nrf;
  assert.equal(totalRows, 5, "all 5 source instances should be represented across the fragment(s)");
});

// The dst/det this test sends are what TR-0071:7.2.2.1 calls "The timestamp filter as the
// start/end time of source data resources ... gets filtered." Whether mobius4 honours that is
// checked empirically below rather than assumed, per features/test-purposes/TR-0071.md
// TP/TR-0071/CSE/DST/CRE/008's note that the exact boundary behaviour needed re-confirming by
// running it.
test("TC_TR0071_DST_CRE_008: TP/TR-0071/CSE/DST/CRE/008 — datasetStartTime/EndTime filter source instances", { todo: true }, async () => {
  // FAILS 2026-08-13: the policy's own dst/det never reach the filtering logic. In
  // cse/resources/dsp.js, `create_a_dsp` calls `get_dataset_info(dsp_res.sri)` (line 51), which
  // recomputes dst/det from the source containers' own <latest>/<oldest> <contentInstance> --
  // and *those* recomputed values (not prim_res.dst/prim_res.det) are what gets passed into
  // `create_a_historical_dataset(dsp_res, dst, det, lof)` (line 57) and from there into
  // `create_historical_dataset_fragments` (cse/datasetManager.js:60), which is the function that
  // does the actual `data.ct >= current_tcst && data.ct < current_tcd_end` filtering (line
  // 201-203). The client-supplied dst/det are stored on the <mlDatasetPolicy> resource itself
  // (dsp.js:93-94, visible on RETRIEVE) but never consulted for fragment generation -- so a
  // narrower dst/det has no effect on which source instances end up in the dataset. Measured:
  // this test's fragment(s) contain all 5 source rows, not the ~2 inside [dst, det). This is a
  // newly discovered gap -- neither features/test-purposes/TR-0071.md's existing note nor the
  // revision proposal names it this precisely; it goes beyond "the exact boundary needs
  // re-checking" to "the boundary is not applied at all".
  const src = await makeSource("src", [{ v: 0 }, { v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }]);
  const dst = src.cts[2]; // third instance's creationTime
  const det = src.cts[3]; // fourth instance's creationTime
  const { res } = await makePolicy({ sri: [src.sid], nrhd: 100, dst, det });
  assert.equal(res.rsc, "2001", `policy create failed: ${res.raw.slice(0, 200)}`);
  const dtsSid = res.body["m2m:dsp"].hdi;
  assert.ok(dtsSid, `historicalDatasetID was not set: ${JSON.stringify(res.body["m2m:dsp"])}`);

  const frags = urils(await discover(srv.baseUrl, dtsSid, { ty: String(TY.DSF) }));
  let totalRows = 0;
  for (const f of frags) totalRows += (await retrieve(srv.baseUrl, f)).body["m2m:dsf"].nrf;
  assert.ok(totalRows < 5, `dst/det should have filtered out at least one instance, got ${totalRows} rows`);
});

test("TC_TR0071_DST_CRE_009: TP/TR-0071/CSE/DST/CRE/009 — data from two sources in the same time window merge into one row", async () => {
  // TR-0071:7.2.2.1 — timeCorrelationDuration "duration for each data batch window", and "When
  // more than one data from source resources get batched as one, this timestamp indicates the
  // start time of each recurring window." The TR does not spell out the merge unit (row-per-time
  // vs. simple grouping); this test follows mobius4's actual interpretation --
  // cse/datasetManager.js's merge_data_for_timewindow builds one row object per source *data
  // item* inside a window, with every known feature (from every source seen so far) as a key on
  // that row (features/test-purposes/TR-0071.md TP/TR-0071/CSE/DST/CRE/009 note: this is an
  // observation of mobius4's behaviour, not a TR- or revision-proposal-backed requirement).
  const srcA = await makeSource("srcA", [{ temp: 21 }]); // written first (earlier ct)
  const srcB = await makeSource("srcB", [{ humi: 40 }]); // written after
  const { res } = await makePolicy({ sri: [srcA.sid, srcB.sid], nrhd: 100, tcd: 60 });
  assert.equal(res.rsc, "2001", `policy create failed: ${res.raw.slice(0, 200)}`);
  const dtsSid = res.body["m2m:dsp"].hdi;

  const frags = urils(await discover(srv.baseUrl, dtsSid, { ty: String(TY.DSF) }));
  assert.equal(frags.length, 1, "both instances fall in one 60s window, so one fragment is expected");
  const dsf = (await retrieve(srv.baseUrl, frags[0])).body["m2m:dsf"];
  assert.equal(dsf.nrf, 2, "one row per source data item");
  // dsfm=1 (JSON): cse/datasetManager.js's convert_to_JSON flattens each row to
  // { time, ...values } -- there is no nested "values" key in the wire representation. Every
  // row carries every feature seen in the window (allFeatures is aggregated across sources), so
  // source A's row also gets a "humi" key (empty, under nvp=0 -- see CRE/010) and source B's row
  // also gets a "temp" key.
  const rows = dsf.dsfr;
  assert.equal(rows.length, 2);
  const rowA = rows.find((r) => r.temp === 21);
  const rowB = rows.find((r) => r.humi === 40);
  assert.ok(rowA && rowB, `expected one row per source: ${JSON.stringify(rows)}`);
  assert.equal(rowA.humi, "", "source A's row should carry source B's feature key too, just empty");
  assert.equal(rowB.temp, "", "source B's row should carry source A's feature key too, just empty");
});

test("TC_TR0071_DST_CRE_010: TP/TR-0071/CSE/DST/CRE/010 — nullValuePolicy=0 leaves a missing feature as an empty string", async () => {
  // TR-0071:7.2.2.1 — nullValuePolicy "e.g. leave as null, fill with last-known values". The TR
  // gives no value domain for this attribute (string vs number, exact spelling); mobius4's value
  // is nvp=0 ("leave as null") -- cse/resources/dsp.js:97, cse/datasetManager.js's
  // merge_data_for_timewindow else-branch (`row.values[feature] = ''`). Not covered by the
  // revision proposal (features/test-purposes/TR-0071.md TP/TR-0071/CSE/DST/CRE/010 note: a
  // newly discovered TR text gap, in the same vein as B-6 but not itself listed there).
  const srcA = await makeSource("srcA", [{ x: 1 }]);
  const srcB = await makeSource("srcB", [{ y: 2 }]);
  const { res } = await makePolicy({ sri: [srcA.sid, srcB.sid], nrhd: 100, tcd: 60, nvp: 0 });
  assert.equal(res.rsc, "2001");
  const dtsSid = res.body["m2m:dsp"].hdi;
  const frags = urils(await discover(srv.baseUrl, dtsSid, { ty: String(TY.DSF) }));
  const dsf = (await retrieve(srv.baseUrl, frags[0])).body["m2m:dsf"];

  // dsfm=1 (JSON): each row is flattened to { time, ...values } (see CRE/009).
  const rowA = dsf.dsfr.find((r) => r.x === 1);
  assert.ok(rowA, `no row carries x=1: ${JSON.stringify(dsf.dsfr)}`);
  assert.equal(rowA.y, "", "a feature this row's source did not provide should be an empty string under nvp=0");
});

test("TC_TR0071_DST_CRE_011: TP/TR-0071/CSE/DST/CRE/011 — nullValuePolicy=1 fills a missing feature with the last known value", async () => {
  // Same TR clause and the same gap as CRE/010 (nullValuePolicy's value domain is not specified
  // in the TR text); mobius4's nvp=1 fills forward from cse/datasetManager.js's lastKnownValues
  // map, built while walking data chronologically.
  const srcB = await makeSource("srcB", [{ y: 5 }]); // written first (earlier ct)
  const srcA = await makeSource("srcA", [{ x: 1 }]); // written after -- lacks "y"
  const { res } = await makePolicy({ sri: [srcA.sid, srcB.sid], nrhd: 100, tcd: 60, nvp: 1 });
  assert.equal(res.rsc, "2001");
  const dtsSid = res.body["m2m:dsp"].hdi;
  const frags = urils(await discover(srv.baseUrl, dtsSid, { ty: String(TY.DSF) }));
  const dsf = (await retrieve(srv.baseUrl, frags[0])).body["m2m:dsf"];

  // dsfm=1 (JSON): each row is flattened to { time, ...values } (see CRE/009).
  const rowA = dsf.dsfr.find((r) => r.x === 1);
  assert.ok(rowA, `no row carries x=1: ${JSON.stringify(dsf.dsfr)}`);
  assert.equal(rowA.y, 5, "a feature this row's source did not provide should carry the last known value under nvp=1");
});

test("TC_TR0071_DST_CRE_012: TP/TR-0071/CSE/DST/CRE/012 — numberOfRowsForLiveDataset defaults to 1", async () => {
  // TR-0071:7.2.2.1 — numberOfRowsForLiveDataset "Default is 1 (one)."
  const src = await makeSource("src", [{ x: 1 }]);
  const { res } = await makePolicy({ sri: [src.sid] }); // no nrld, no nrhd
  assert.equal(res.rsc, "2001", `policy create failed: ${res.raw.slice(0, 200)}`);
  assert.equal(res.body["m2m:dsp"].nrld, 1);
});

test("TC_TR0071_DST_CRE_013: TP/TR-0071/CSE/DST/CRE/013 — an absent numberOfRowsForHistoricalDataset is reported as unset", async () => {
  // TR-0071:7.2.2.1 says the default is "all" (one fragment holding every row). mobius4 stores
  // an absent nrhd as null and reports it as an absent field on RETRIEVE (cse/resources/dsp.js:
  // 101, 174 -- `if (db_res.nrhd !== null) ...`), which this test checks. The *behavioural*
  // default (how many rows actually land in one fragment) is a different thing: the fragment
  // builder resolves an absent nrhd to config/default.json's datasetPolicy.nrhd = 1000
  // (cse/datasetManager.js:39, dsp_default.nrhd), not literally "all" -- that is a separate claim
  // from what this test (the DSP response field) checks, and is left to a fragment-count test
  // rather than asserted here.
  const src = await makeSource("src", [{ x: 1 }]);
  const { res } = await makePolicy({ sri: [src.sid] }); // no nrhd
  assert.equal(res.rsc, "2001", `policy create failed: ${res.raw.slice(0, 200)}`);
  assert.equal(res.body["m2m:dsp"].nrhd, undefined);
});

test("TC_TR0071_DST_CRE_014: TP/TR-0071/CSE/DST/CRE/014 — listOfFeatures reflects the source content's leaf keys", async () => {
  // TR-0071:7.2.2.2 listOfFeatures "The list of dataset feature names," combined with
  // 7.2.2.1's sourceResourceIDs description of what gets pulled out of a <container> source's
  // <contentInstance>.con.
  const src = await makeSource("src", [{ temperature: 21.5, humidity: 40 }]);
  const { res } = await makePolicy({ sri: [src.sid], nrhd: 100 });
  assert.equal(res.rsc, "2001");
  const dts = (await retrieve(srv.baseUrl, res.body["m2m:dsp"].hdi)).body["m2m:dts"];
  assert.ok(dts.lof.includes("temperature"), `listOfFeatures should include temperature: ${JSON.stringify(dts.lof)}`);
  assert.ok(dts.lof.includes("humidity"), `listOfFeatures should include humidity: ${JSON.stringify(dts.lof)}`);
});

test("TC_TR0071_DST_RET_001: TP/TR-0071/CSE/DST/RET/001 — <latest> resolves to the newest <datasetFragment>", async () => {
  // TR-0071:7.2.2.2 — <latest> "This virtual resource refers the latest <datasetFragment>
  // resource," without defining the sort key. Project decision B-1 (docs/tr-0071-revision-
  // proposal.md) settles this for <modelRepo>'s <latest>/<oldest> as creationTime-based; this
  // test applies the same reasoning to <dataset> (features/test-purposes/TR-0071.md
  // TP/TR-0071/CSE/DST/RET/001 note: B-1 does not literally name <dataset>, but <datasetFragment>
  // has no stateTag either, so the same gap applies and mobius4 resolves it the same way --
  // cse/resources/dts.js retrieve_la -> dsf.find_edge_dsf, ordered by ct/ri).
  const { dtsSid } = await makeDatasetWithFragment(3);
  const got = await retrieve(srv.baseUrl, `${dtsSid}/la`);
  assert.equal(got.rsc, "2000", `<latest> retrieve failed: ${got.raw.slice(0, 200)}`);
  assert.equal(got.body["m2m:dsf"].ty, TY.DSF);
});

test("TC_TR0071_DST_RET_002: TP/TR-0071/CSE/DST/RET/002 — <oldest> resolves to the oldest <datasetFragment>", async () => {
  const { dtsSid } = await makeDatasetWithFragment(3);
  const got = await retrieve(srv.baseUrl, `${dtsSid}/ol`);
  assert.equal(got.rsc, "2000", `<oldest> retrieve failed: ${got.raw.slice(0, 200)}`);
  assert.equal(got.body["m2m:dsf"].ty, TY.DSF);
});

test("TC_TR0071_DST_RET_003: TP/TR-0071/CSE/DST/RET/003 — datasetFragmentStartTime/EndTime bound the fragment's rows", async () => {
  // TR-0071:7.2.2.3 — datasetFragmentStartTime "The oldest timestamp among the data",
  // datasetFragmentEndTime "The latest timestamp among the data".
  const { dsfSid } = await makeDatasetWithFragment(3);
  const dsf = (await retrieve(srv.baseUrl, dsfSid)).body["m2m:dsf"];
  assert.ok(dsf.dfst, "datasetFragmentStartTime should be set");
  assert.ok(dsf.dfet, "datasetFragmentEndTime should be set");
  assert.ok(dsf.dfst <= dsf.dfet, "start should not be after end");
});

test("TC_TR0071_DST_RET_004: TP/TR-0071/CSE/DST/RET/004 — numberOfRowsInFragment matches the row count", async () => {
  // TR-0071:7.2.2.3 — numberOfRowsInFragment "The number of data in the dataset attribute."
  const { dsfSid } = await makeDatasetWithFragment(3);
  const dsf = (await retrieve(srv.baseUrl, dsfSid)).body["m2m:dsf"];
  assert.equal(dsf.nrf, dsf.dsfr.length);
});

test("TC_TR0071_DST_UPD_001: TP/TR-0071/CSE/DST/UPD/001 — <datasetFragment> is immutable", async () => {
  // TR-0071:7.2.3.3 — "this resource is immutable so Update procedure is not specified." mobius4
  // has no dsf.update_a_dsf at all: hostingCSE.js's UPDATE dispatch table has no case for 106 or
  // 107, so both fall to the default branch (rsc = OPERATION_NOT_ALLOWED, 4005) -- a routing gap
  // rather than a dedicated immutability check, but the observable result matches what the TR
  // asks for. features/test-purposes/TR-0071.md TP/TR-0071/CSE/DST/UPD/001.
  const { dsfSid } = await makeDatasetWithFragment();
  const res = await update(srv.baseUrl, dsfSid, { "m2m:dsf": { lbl: ["changed"] } });
  assert.equal(res.rsc, "4005", `expected OPERATION_NOT_ALLOWED: ${res.raw.slice(0, 200)}`);
});

// FAILS 2026-08-14 -- but for a different reason than before, and not one this harness can work
// around by adding an MQTT broker fixture. Two prior blockers are gone: BACKLOG-092
// (create_a_live_dataset's `dsp_ri` referenced outside the callback scope that defines it,
// cse/datasetManager.js) and BACKLOG-094 (<dataset> missing from sub.js's sub_parent_res_types)
// are both fixed, so the policy CREATE now returns 2001 with a liveDatasetID and the
// <subscription> under it now returns 2001 too. This harness also still runs with
// mqtt.enabled=false (test/helpers/server.js's startServer() only enables mqtt when a caller
// passes mqttPort, which this file's `before` hook does not), so create_a_live_dsf's
// batch_data[dsp_ri] stays empty here too -- BUT a real MQTT broker would not fix this test
// either, verified by hand outside this harness (real mobius4 process + real mosquitto broker on
// the port cse/datasetManager.js:329 hard-codes, 'mqtt://localhost:1883/...'): batch_data *did*
// populate and a <datasetFragment> *was* created under the live <dataset> -- but no notification
// ever reached the subscriber. The reason: create_a_live_dsf (cse/datasetManager.js) creates the
// <datasetFragment> by calling cse/resources/dsf.js's create_a_dsf(...) directly. CREATE
// notifications are only ever sent from cse/hostingCSE.js's create_a_res, in the block right
// after its dispatch switch calls `case 107: await dsf.create_a_dsf(...)` (the same call
// datasetManager.js makes standalone) -- `noti.check_and_send_noti(req_prim, resp_prim_copy,
// "create")`. dsf.js's create_a_dsf has no notification call of its own. So every internally
// created <datasetFragment> (live or historical) is notification-silent regardless of whether
// MQTT works. This is a third, independent gap -- not BACKLOG-092, not BACKLOG-094, and not
// covered by the revision proposal. Marked todo rather than worked around with the still-open
// direct-CREATE gap (CRE/006) -- that would test the generic notification mechanism through the
// normal client path, not this TP's specific claim about the live-collection flow notifying
// through its actual (internal) creation path, and would misrepresent what was actually
// verified.
test("TC_TR0071_DST_NTF_001: TP/TR-0071/CSE/DST/NTF/001 — a new live <datasetFragment> notifies a subscriber", { todo: true }, async () => {
  const sink = await startSink();
  try {
    const src = await makeSource("src", [{ x: 1 }]);
    const { res } = await makePolicy({ sri: [src.sid], nrld: 1, tcd: 2 });
    assert.equal(res.rsc, "2001", `policy create failed: ${res.raw.slice(0, 200)}`);
    const dtsSid = res.body["m2m:dsp"].ldi;
    assert.ok(dtsSid, "liveDatasetID was not set");

    const sub = await create(srv.baseUrl, dtsSid, 23,
      { "m2m:sub": { rn: uniqueRn("s"), nu: [sink.url], enc: { net: [3], chty: [TY.DSF] } } });
    assert.equal(sub.rsc, "2001");

    const noti = await sink.waitFor((i) => i.body && i.body["m2m:sgn"], { timeoutMs: 8000 });
    assert.ok(noti.body["m2m:sgn"].nev.rep["m2m:dsf"], "notification should carry the new <datasetFragment>");
  } finally {
    await sink.stop();
  }
});
