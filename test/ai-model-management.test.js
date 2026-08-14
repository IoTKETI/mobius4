"use strict";
// TR-0071 AI/ML model management — <modelRepo>, <mlModel>, <modelDeploymentList>, <modelDeployment>.
//
// These resource types come from oneM2M TR-0071 (a Technical Report), not from a TS. That has a
// direct consequence for this file: TS-0018 defines no test purposes for them, so the assertions
// here are derived from the TR text itself and carry our own identifiers
// (TP/TR-0071/CSE/MDL/..., TP/TR-0071/CSE/DPL/..., see features/test-purposes/TR-0071.md in the
// development repository, mobius4-dev-tool). The identifiers deliberately do not look like
// oneM2M's — an invented TP/oneM2M/... number would read as a citation to a real conformance
// test that does not exist.
//
// This is not TDD: the implementation predates these tests, so "run and record which way it
// came out" replaces "watch it go red then green". Where an assertion fails because the
// implementation predates or diverges from the TR, the test is left in place and marked
// { todo: true } with the reason spelled out in a comment above it, citing the TR clause and
// the mobius4 source line that produced the actual behaviour. Deleting a failing test would
// erase the finding.
//
// Short names: TR-0071 registers only long names (it is a TR, not a TS, so TS-0004 §8.2 has no
// entry for them yet). The short names below (mrp/mmd/mdp/dpm, cnmo/cbmo/mnmo/mbmo/vr/plf/mlt/
// mmd/mmu/mms/ips/ous, ndm/nrm/nsm, moid/mcmd/mds/inr/our) are mobius4's actual wire names, taken
// from corpus/symbols/tr-0071.yaml (measured against models/*.js and cse/resources/*.js on
// 2026-08-13) rather than the mocm/most placeholders in the task-11 brief, which predate that
// measurement.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, retrieve, update, remove, uniqueRn, CSE_BASE } = require("./helpers/onem2m");
const { startSink } = require("./helpers/noti-sink");

const TY = { MRP: 101, MMD: 102, MDP: 103, DPM: 104, CNT: 3 };

let srv;

before(async () => { srv = await startServer(); });
after(async () => { if (srv) await srv.stop(); });

// <modelRepo>/<modelDeploymentList> accept <CSEBase>, <AE> and <remoteCSE> as parents
// (cse/resources/mrp.js mrp_parent_res_types, cse/resources/mdp.js mdp_parent_res_types). Every
// resource in this file is created directly under <CSEBase> — TR-0071 does not require an <AE>
// for any of the atomic behaviour under test, and every request here is sent as the same
// default originator (ADMIN, see test/helpers/onem2m.js), so there is no access-control reason
// to nest under an <AE> either.
async function makeRepo(extra = {}) {
  const rn = uniqueRn("mrp");
  const res = await create(srv.baseUrl, CSE_BASE, TY.MRP, { "m2m:mrp": { rn, ...extra } });
  assert.equal(res.rsc, "2001", `repo create failed: ${res.raw.slice(0, 200)}`);
  return { rn, sid: `${CSE_BASE}/${rn}`, body: res.body["m2m:mrp"] };
}

function modelBody(rn, extra = {}) {
  // TR-0071 table 7.1.2.2-2: version/platform/mlType are multiplicity 1. mmd/mmu are mutually
  // exclusive and exactly one is required (BACKLOG-086) -- a caller that does not care which one
  // gets a default mmu, so fixtures that only care about vr/plf/mlt (or another attribute) do not
  // each have to think about it. A caller supplying either explicitly (mmd included) is left
  // alone rather than getting a second, conflicting default.
  const base = { rn, vr: "1.0.0", plf: "tensorFlow", mlt: "regression" };
  if (extra.mmd === undefined && extra.mmu === undefined) {
    base.mmu = "https://example.invalid/default-model.tflite";
  }
  return { "m2m:mmd": { ...base, ...extra } };
}

// A base64 string that decodes to exactly `n` bytes -- BACKLOG-087 measures mlModelSize off the
// decoded buffer, not the base64 text, so fixtures that need a model of a known byte size build
// it this way rather than picking an arbitrary base64-alphabet string and hoping its decoded
// length lines up.
function base64Bytes(n) {
  return Buffer.alloc(n, "m").toString("base64");
}

async function makeModel(repoSid, extra = {}) {
  const rn = uniqueRn("mmd");
  const res = await create(srv.baseUrl, repoSid, TY.MMD, modelBody(rn, extra));
  assert.equal(res.rsc, "2001", `model create failed: ${res.raw.slice(0, 200)}`);
  return { rn, sid: `${repoSid}/${rn}`, ri: res.body["m2m:mmd"].ri, body: res.body["m2m:mmd"] };
}

async function makeDeploymentList(extra = {}) {
  const rn = uniqueRn("mdp");
  const res = await create(srv.baseUrl, CSE_BASE, TY.MDP, { "m2m:mdp": { rn, ...extra } });
  assert.equal(res.rsc, "2001", `deployment list create failed: ${res.raw.slice(0, 200)}`);
  return { rn, sid: `${CSE_BASE}/${rn}`, body: res.body["m2m:mdp"] };
}

async function makeContainer() {
  const rn = uniqueRn("c");
  const res = await create(srv.baseUrl, CSE_BASE, TY.CNT, { "m2m:cnt": { rn } });
  assert.equal(res.rsc, "2001");
  return `${CSE_BASE}/${rn}`;
}

// A <modelDeployment> referencing a real (if unused) <mlModel>, with real input/output
// <container>s, ready for a modelCommand transition.
async function makeDeployedModel() {
  const repo = await makeRepo();
  const model = await makeModel(repo.sid, { mmu: "https://example.invalid/m.tflite" });
  const list = await makeDeploymentList();
  const inr = await makeContainer();
  const our = await makeContainer();
  const rn = uniqueRn("dpm");
  const res = await create(srv.baseUrl, list.sid, TY.DPM,
    { "m2m:dpm": { rn, moid: model.ri, inr, our } });
  assert.equal(res.rsc, "2001", `deployment create failed: ${res.raw.slice(0, 200)}`);
  return { rn, sid: `${list.sid}/${rn}`, list, model, inr, our, body: res.body["m2m:dpm"] };
}

// -------------------------------------------------------------------------------------------
// MDL group -- <modelRepo>, <mlModel>
// -------------------------------------------------------------------------------------------

test("TC_TR0071_MDL_CRE_001: TP/TR-0071/CSE/MDL/CRE/001 — a new <modelRepo> reports zero models", async () => {
  const repo = await makeRepo();
  // TR-0071 table 7.1.2.1-2: currentNumberOfModels/currentByteOfModels are RO. The TR does not
  // say what the initial value is; 0 is mobius4's default (models/mrp-model.js) and is also the
  // only reading consistent with "no <mlModel> children yet" (features/test-purposes/TR-0071.md
  // TP/TR-0071/CSE/MDL/CRE/001 note).
  assert.equal(repo.body.cnmo, 0);
  assert.equal(repo.body.cbmo, 0);
});

test("TC_TR0071_MDL_CRE_002: TP/TR-0071/CSE/MDL/CRE/002 — vr, plf and mlt are mandatory", async () => {
  const repo = await makeRepo();
  // TR-0071 table 7.1.2.2-2: version/platform/mlType are multiplicity 1. mobius4 enforces this
  // by hand (cse/resources/mmd.js:30-34, BACKLOG-060 — no Joi schema for this non-standard type).
  for (const drop of ["vr", "plf", "mlt"]) {
    const body = modelBody(uniqueRn("mmd"));
    delete body["m2m:mmd"][drop];
    const res = await create(srv.baseUrl, repo.sid, TY.MMD, body);
    assert.equal(res.rsc, "4000", `dropping ${drop} should be rejected: ${res.raw.slice(0, 200)}`);
  }
});

// Fixed 2026-08-14 (BACKLOG-086). create_an_mmd (cse/resources/mmd.js) now rejects a CREATE that
// carries both mmd and mmu, and one that carries neither (the revision proposal's stricter
// "exactly one" reading, item B-4).
test("TC_TR0071_MDL_CRE_003: TP/TR-0071/CSE/MDL/CRE/003 — mlModel and mlModelURL are mutually exclusive", async () => {
  const repo = await makeRepo();
  const res = await create(srv.baseUrl, repo.sid, TY.MMD,
    modelBody(uniqueRn("mmd"), { mmd: Buffer.from("fake-model").toString("base64"), mmu: "https://example.invalid/m.tflite" }));
  assert.match(String(res.rsc), /^4/, `expected a client-error RSC, got ${res.rsc}: ${res.raw.slice(0, 200)}`);
});

test("TC_TR0071_MDL_CRE_004: TP/TR-0071/CSE/MDL/CRE/004 — mlModelSize is the byte length of the mlModel field as stored", async () => {
  // TR-0071 table 7.1.2.2-2 says only "The byte size of the ML model stored in mlModel" — it
  // does not say whether that is the byte size of the base64 *text* or of the binary it decodes
  // to (features/test-purposes/TR-0071.md TP/TR-0071/CSE/MDL/CRE/004 note: a TR text gap, not
  // covered by the revision proposal). Fixed 2026-08-14 (BACKLOG-087): mobius4 now stores the
  // *decoded* bytes (models/mmd-model.js's mmd column is BYTEA) and measures mms off that buffer
  // (cse/resources/mmd.js's decode_base64_mlmodel), so this is now literally true of the stored
  // representation rather than of the base64 text that arrived over the wire.
  const raw = base64Bytes(24);
  const res = await create(srv.baseUrl, (await makeRepo()).sid, TY.MMD, modelBody(uniqueRn("mmd"), { mmd: raw }));
  assert.equal(res.rsc, "2001", `model create failed: ${res.raw.slice(0, 200)}`);
  assert.equal(res.body["m2m:mmd"].mms, 24);
});

// Not tied to a TP/TR-0071 identifier -- features/test-purposes/TR-0071.md has none for this; it
// is a regression guard for the BACKLOG-087 storage change itself (mmd.mmd is now BYTEA, decoded
// on CREATE/UPDATE and re-encoded to base64 on RETRIEVE), not a TR-derived assertion. The point:
// a BYTEA column must not silently corrupt bytes the way a TEXT column receiving raw binary
// would -- 0xFF/0xFE and the lone/paired UTF-16 surrogate byte sequences below are not valid
// UTF-8, so decoding into a JS string anywhere on this path (rather than staying a Buffer) would
// corrupt them before they ever reached the database.
test("BACKLOG-087: mlModel round-trips arbitrary binary through base64, including bytes that are not valid UTF-8", async () => {
  const raw = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28, 0xed, 0xa0, 0x80]);
  const repo = await makeRepo();
  const res = await create(srv.baseUrl, repo.sid, TY.MMD, modelBody(uniqueRn("mmd"), { mmd: raw.toString("base64") }));
  assert.equal(res.rsc, "2001", `model create failed: ${res.raw.slice(0, 200)}`);
  assert.equal(res.body["m2m:mmd"].mms, raw.length, "mlModelSize should be the decoded byte length");

  const got = await retrieve(srv.baseUrl, `${repo.sid}/${res.body["m2m:mmd"].rn}`);
  assert.equal(got.rsc, "2000");
  const roundTripped = Buffer.from(got.body["m2m:mmd"].mmd, "base64");
  assert.ok(roundTripped.equals(raw),
    `expected the decoded bytes to round-trip unchanged, got ${roundTripped.toString("hex")} vs ${raw.toString("hex")}`);
});

// BACKLOG-087's canonicalisation decision: what the CSE guarantees across CREATE -> RETRIEVE is
// the attribute's *value* (the bytes), not its *encoding*. A client that sends non-canonical
// base64 -- missing padding, or wrapped across lines -- gets back the same bytes, re-encoded
// canonically; it does not get its own text back verbatim.
test("BACKLOG-087: non-canonical base64 (missing padding, embedded newlines) is accepted and decodes to the same bytes", async () => {
  const raw = Buffer.from("hello, mobius4!");
  const canonical = raw.toString("base64"); // padded, single line
  const noPadding = canonical.replace(/=+$/, "");
  const withNewlines = canonical.match(/.{1,4}/g).join("\n"); // wrapped every 4 characters
  const repo = await makeRepo();

  const res1 = await create(srv.baseUrl, repo.sid, TY.MMD, modelBody(uniqueRn("mmd"), { mmd: noPadding }));
  assert.equal(res1.rsc, "2001", `missing-padding base64 should be accepted: ${res1.raw.slice(0, 200)}`);
  assert.ok(Buffer.from(res1.body["m2m:mmd"].mmd, "base64").equals(raw), "missing-padding input should decode to the same bytes");

  const res2 = await create(srv.baseUrl, repo.sid, TY.MMD, modelBody(uniqueRn("mmd"), { mmd: withNewlines }));
  assert.equal(res2.rsc, "2001", `newline-wrapped base64 should be accepted: ${res2.raw.slice(0, 200)}`);
  assert.ok(Buffer.from(res2.body["m2m:mmd"].mmd, "base64").equals(raw), "newline-wrapped input should decode to the same bytes");
});

// BACKLOG-087: input that is not valid base64 at all must be rejected, not stored as whatever
// bytes Buffer.from(str, "base64") happens to produce after silently dropping the invalid
// characters.
test("BACKLOG-087: mmd that is not valid base64 is rejected rather than stored as garbage", async () => {
  const repo = await makeRepo();
  const res = await create(srv.baseUrl, repo.sid, TY.MMD, modelBody(uniqueRn("mmd"), { mmd: "not-valid-base64!!" }));
  assert.equal(res.rsc, "4000", `expected invalid base64 to be rejected, got ${res.rsc}: ${res.raw.slice(0, 200)}`);
});

test("TC_TR0071_MDL_CRE_005: TP/TR-0071/CSE/MDL/CRE/005 — creating a model increments the parent's currentNumberOfModels", async () => {
  const repo = await makeRepo();
  await makeModel(repo.sid);
  // TR-0071:7.1.2.1 — currentNumberOfModels "The current number of ML models in the repository".
  const got = await retrieve(srv.baseUrl, repo.sid);
  assert.equal(got.body["m2m:mrp"].cnmo, 1);
});

test("TC_TR0071_MDL_CRE_006: TP/TR-0071/CSE/MDL/CRE/006 — exceeding maxNumberOfModels evicts the oldest sibling", async () => {
  // TR-0071 itself does not define this behaviour (maxNumberOfModels is just "the maximum number
  // ... which can be stored"). This is project decision B-2 (docs/tr-0071-revision-proposal.md):
  // borrow <container>'s retention behaviour and evict the oldest child rather than reject the
  // create. mobius4 already implements it this way (cse/resources/mmd.js update_parent_mrp,
  // find_edge_mmd) — features/test-purposes/TR-0071.md TP/TR-0071/CSE/MDL/CRE/006.
  const repo = await makeRepo({ mnmo: 1 });
  const mmdA = await makeModel(repo.sid);
  const mmdB = await makeModel(repo.sid);

  const gotA = await retrieve(srv.baseUrl, mmdA.sid);
  assert.equal(gotA.rsc, "4004", "the oldest model should have been evicted");
  const gotB = await retrieve(srv.baseUrl, mmdB.sid);
  assert.equal(gotB.rsc, "2000", "the model that triggered the eviction must survive");
  const gotRepo = await retrieve(srv.baseUrl, repo.sid);
  assert.equal(gotRepo.body["m2m:mrp"].cnmo, 1);
});

test("TC_TR0071_MDL_CRE_007: TP/TR-0071/CSE/MDL/CRE/007 — exceeding maxByteOfModels rejects the create instead of evicting", async () => {
  // Unlike maxNumberOfModels (CRE/006), mobius4 refuses the create when the byte budget would be
  // exceeded rather than evicting -- cse/resources/mmd.js:56-60, with a comment noting the TR
  // does not define eviction-by-byte-budget either way. This is a documented asymmetry with B-2
  // (docs/tr-0071-revision-proposal.md), which proposes evicting on both limits; mobius4 does
  // not do that for bytes. features/test-purposes/TR-0071.md TP/TR-0071/CSE/MDL/CRE/007 flags
  // this as a newly discovered inconsistency between the two proposed behaviours, not something
  // the revision proposal resolves — so this test asserts what mobius4 actually does.
  const repo = await makeRepo({ mbmo: 100 });
  const first = await makeModel(repo.sid, { mmd: base64Bytes(90) }); // mms = 90 decoded bytes
  assert.equal(first.body.mms, 90);

  const second = await create(srv.baseUrl, repo.sid, TY.MMD, modelBody(uniqueRn("mmd"), { mmd: base64Bytes(20) })); // would push cbmo to 110 > 100
  assert.equal(second.rsc, "5207", `expected NOT_ACCEPTABLE: ${second.raw.slice(0, 200)}`);

  const survivor = await retrieve(srv.baseUrl, first.sid);
  assert.equal(survivor.rsc, "2000", "the byte-budget rejection must not evict the existing model");
  const gotRepo = await retrieve(srv.baseUrl, repo.sid);
  assert.equal(gotRepo.body["m2m:mrp"].cbmo, 90);
});

test("TC_TR0071_MDL_CRE_008: TP/TR-0071/CSE/MDL/CRE/008 — an absent maxNumberOfModels means unlimited", async () => {
  // Not stated by the TR text (maxNumberOfModels multiplicity 0..1) -- project decision (see
  // TP/TR-0071/CSE/MDL/CRE/008 note): an absent limit means no limit, mirroring <container>'s
  // maxNrOfInstances. This is also a regression guard: cse/resources/mmd.js:147 must treat a null
  // mnmo as "no limit" rather than coercing it to a falsy 0, which used to evict on the very
  // first <mlModel> insert (see the comment at that line).
  const repo = await makeRepo();
  const models = [];
  for (let i = 0; i < 6; i++) models.push(await makeModel(repo.sid));

  for (const m of models) {
    const got = await retrieve(srv.baseUrl, m.sid);
    assert.equal(got.rsc, "2000", `${m.rn} should not have been evicted`);
  }
  const gotRepo = await retrieve(srv.baseUrl, repo.sid);
  assert.equal(gotRepo.body["m2m:mrp"].cnmo, 6);
});

test("TC_TR0071_MDL_RET_001: TP/TR-0071/CSE/MDL/RET/001 — inputSample and outputSample round-trip unchanged", async () => {
  // TR-0071 table 7.1.2.2-2: inputSample/outputSample.
  const repo = await makeRepo();
  const model = await makeModel(repo.sid, { ips: "sample-in", ous: "sample-out" });
  const got = await retrieve(srv.baseUrl, model.sid);
  assert.equal(got.body["m2m:mmd"].ips, "sample-in");
  assert.equal(got.body["m2m:mmd"].ous, "sample-out");
});

test("TC_TR0071_MDL_UPD_001: TP/TR-0071/CSE/MDL/UPD/001 — mlModelSize is immutable", async () => {
  // TR-0071 table 7.1.2.2-2: mlModelSize is RO.
  const repo = await makeRepo();
  const model = await makeModel(repo.sid, { mmd: base64Bytes(1234) });
  const res = await update(srv.baseUrl, model.sid, { "m2m:mmd": { mms: 9999 } });
  assert.equal(res.rsc, "4000", `expected mms update to be rejected: ${res.raw.slice(0, 200)}`);
});

// FAILS 2026-08-13: currentNumberOfModels/currentByteOfModels do not decrease when a client
// deletes an <mlModel> directly. hostingCSE.js's generic delete_a_res (692-799) special-cases
// only ty===4 (<contentInstance>, updating the parent <container>'s cni/cbs) — there is no
// equivalent case for ty===102 (<mlModel>). The only place cnmo/cbmo ever decrease is the
// eviction path in cse/resources/mmd.js's update_parent_mrp (CRE/006), which calls
// delete_a_res itself and then manually adjusts the counters afterwards; a client-initiated
// DELETE never goes through that function. Flagged in features/test-purposes/TR-0071.md
// TP/TR-0071/CSE/MDL/DEL/001 as a newly discovered gap -- neither the TR nor the revision
// proposal addresses direct-delete bookkeeping.
test("TC_TR0071_MDL_DEL_001: TP/TR-0071/CSE/MDL/DEL/001 — deleting an <mlModel> decrements the parent's counters", { todo: true }, async () => {
  const repo = await makeRepo();
  const model = await makeModel(repo.sid, { mmd: "z".repeat(100) }); // mms = 100
  let gotRepo = await retrieve(srv.baseUrl, repo.sid);
  assert.equal(gotRepo.body["m2m:mrp"].cnmo, 1);
  assert.equal(gotRepo.body["m2m:mrp"].cbmo, 100);

  const del = await remove(srv.baseUrl, model.sid);
  assert.equal(del.rsc, "2002");

  gotRepo = await retrieve(srv.baseUrl, repo.sid);
  // TS-0004:7.4.7.2.4 gives the analogous rule for <container>'s cni/cbs on <contentInstance>
  // deletion; TR-0071 implies the same for a repository that "stores" its models.
  assert.equal(gotRepo.body["m2m:mrp"].cnmo, 0);
  assert.equal(gotRepo.body["m2m:mrp"].cbmo, 0);
});

// -------------------------------------------------------------------------------------------
// DPL group -- <modelDeploymentList>, <modelDeployment>
// -------------------------------------------------------------------------------------------

test("TC_TR0071_DPL_CRE_001: TP/TR-0071/CSE/DPL/CRE/001 — a new <modelDeployment> defaults to deployed (0)", async () => {
  const list = await makeDeploymentList();
  const rn = uniqueRn("dpm");
  const res = await create(srv.baseUrl, list.sid, TY.DPM, { "m2m:dpm": { rn } });
  assert.equal(res.rsc, "2001", `deployment create failed: ${res.raw.slice(0, 200)}`);
  // TR-0071:7.1.2.4 says the default modelStatus is the string "deployed". Project decision B-6
  // (docs/tr-0071-revision-proposal.md): oneM2M enumerations are numeric wire values, not string
  // literals, and mobius4 already implements modelStatus as an integer (0=deployed, 1=running,
  // 2=stopped -- cse/resources/dpm.js:50). B-6 itself proposes registering 1=deployed/2=running/
  // 3=stopped (numbering from 1, the usual oneM2M convention) once this reaches a TS, which would
  // require reworking mobius4's numbering -- but that is a future TS-alignment step, not
  // something this test should require today.
  assert.equal(res.body["m2m:dpm"].mds, 0);
});

test("TC_TR0071_DPL_CRE_002: TP/TR-0071/CSE/DPL/CRE/002 — creating a deployment increments numberOfDeployedModels", async () => {
  const list = await makeDeploymentList();
  await create(srv.baseUrl, list.sid, TY.DPM, { "m2m:dpm": { rn: uniqueRn("dpm") } });
  // TR-0071:7.1.2.3 — numberOfDeployedModels "the number of ML models whose status is 'deployed'".
  const got = await retrieve(srv.baseUrl, list.sid);
  assert.equal(got.body["m2m:mdp"].ndm, 1);
});

test("TC_TR0071_DPL_UPD_001: TP/TR-0071/CSE/DPL/UPD/001 — modelCommand=1 (run) moves deployed to running", async () => {
  const dep = await makeDeployedModel();
  // TR-0071:7.1.3.4: "For the start 'run' ... command, the status shall be updated as 'running'".
  // Project decision B-6: 1 stands for the TR's "run" (see CRE/001 note).
  const res = await update(srv.baseUrl, dep.sid, { "m2m:dpm": { mcmd: 1 } });
  assert.equal(res.rsc, "2004", `expected UPDATED: ${res.raw.slice(0, 200)}`);
  assert.equal(res.body["m2m:dpm"].mds, 1);

  const list1 = (await retrieve(srv.baseUrl, dep.list.sid)).body["m2m:mdp"];
  assert.equal(list1.ndm, 0, "numberOfDeployedModels");
  assert.equal(list1.nrm, 1, "numberOfRunningModels");
});

test("TC_TR0071_DPL_UPD_002: TP/TR-0071/CSE/DPL/UPD/002 — modelCommand=0 (stop) moves running to stopped", async () => {
  const dep = await makeDeployedModel();
  await update(srv.baseUrl, dep.sid, { "m2m:dpm": { mcmd: 1 } }); // deployed -> running first
  // TR-0071:7.1.3.4: "For the ... 'stop' command, the status shall be updated as ... 'stopped'".
  const res = await update(srv.baseUrl, dep.sid, { "m2m:dpm": { mcmd: 0 } });
  assert.equal(res.rsc, "2004");
  assert.equal(res.body["m2m:dpm"].mds, 2);

  const list1 = (await retrieve(srv.baseUrl, dep.list.sid)).body["m2m:mdp"];
  assert.equal(list1.nrm, 0);
  assert.equal(list1.nsm, 1, "numberOfStoppedModels");
});

test("TC_TR0071_DPL_UPD_003: TP/TR-0071/CSE/DPL/UPD/003 — a status change updates the parent's three counters together", async () => {
  // TR-0071:7.1.3.4 — "When the modelStatus attribute is updated, the Hosting CSE shall update
  // the corresponding attributes (i.e. numberOfDeployedModels, numberOfRunningModels,
  // numberOfStoppedModels) of a parent <modelDeploymentList> resource as well."
  const dep = await makeDeployedModel();
  let list1 = (await retrieve(srv.baseUrl, dep.list.sid)).body["m2m:mdp"];
  assert.equal(list1.ndm, 1);
  assert.equal(list1.nrm, 0);
  assert.equal(list1.nsm, 0);

  await update(srv.baseUrl, dep.sid, { "m2m:dpm": { mcmd: 1 } });
  list1 = (await retrieve(srv.baseUrl, dep.list.sid)).body["m2m:mdp"];
  assert.equal(list1.ndm, 0);
  assert.equal(list1.nrm, 1);
  assert.equal(list1.nsm, 0);
});

test("TC_TR0071_DPL_UPD_004: TP/TR-0071/CSE/DPL/UPD/004 — modelCommand is never returned", async () => {
  const dep = await makeDeployedModel();
  // TR-0071 table 7.1.2.4-2: "This attribute is not returned in a response, but can be included
  // in an Update request." cse/resources/dpm.js:159, retrieve_a_dpm never copies mcmd out.
  const res = await update(srv.baseUrl, dep.sid, { "m2m:dpm": { mcmd: 1 } });
  assert.equal(res.rsc, "2004");
  assert.equal(res.body["m2m:dpm"].mcmd, undefined, "modelCommand leaked into the UPDATE response");

  const got = await retrieve(srv.baseUrl, dep.sid);
  assert.equal(got.body["m2m:dpm"].mcmd, undefined, "modelCommand leaked into the RETRIEVE response");
});

test("TC_TR0071_DPL_UPD_005: TP/TR-0071/CSE/DPL/UPD/005 — modelStatus cannot be set directly", async () => {
  // TR-0071 table 7.1.2.4-2: modelStatus is RO. cse/resources/dpm.js:180-181 rejects a truthy
  // prim_res.mds outright ("moid and mds are immutable"). A falsy mds (0) would slip past that
  // guard silently rather than error -- this test uses a truthy value (1) so it actually
  // exercises the rejection.
  const dep = await makeDeployedModel();
  const res = await update(srv.baseUrl, dep.sid, { "m2m:dpm": { mds: 1 } });
  assert.equal(res.rsc, "4000", `expected direct mds update to be rejected: ${res.raw.slice(0, 200)}`);
});

// FAILS 2026-08-13: mobius4 accepts and silently stores an out-of-range modelCommand instead of
// rejecting it. TR-0071:7.1.3.4 only defines "run" and "stop" (project decision B-6: 1 and 0).
// cse/resources/dpm.js:198-229 has three `if` blocks, one per defined (mds, mcmd) transition; a
// value like mcmd=9 matches none of them, so no counters change and modelStatus stays put -- but
// line 229 (`db_res.mcmd = prim_res.mcmd`) runs unconditionally whenever mcmd is present, so 9 is
// saved anyway and the response is 2004 UPDATED, not a rejection. Flagged in
// features/test-purposes/TR-0071.md TP/TR-0071/CSE/DPL/UPD/006; neither the TR nor the revision
// proposal addresses out-of-range modelCommand values.
test("TC_TR0071_DPL_UPD_006: TP/TR-0071/CSE/DPL/UPD/006 — an out-of-range modelCommand is rejected", { todo: true }, async () => {
  const dep = await makeDeployedModel();
  const res = await update(srv.baseUrl, dep.sid, { "m2m:dpm": { mcmd: 9 } });
  assert.equal(res.rsc, "4000", `expected an out-of-range modelCommand to be rejected: got ${res.rsc}`);
});

test("TC_TR0071_DPL_RET_001: TP/TR-0071/CSE/DPL/RET/001 — modelID resolves to a real <mlModel>", async () => {
  // TR-0071:7.1.2.4 — modelID "The resource ID of the <mlModel> resource that is deployed."
  const repo = await makeRepo();
  const model = await makeModel(repo.sid);
  const list = await makeDeploymentList();
  const rn = uniqueRn("dpm");
  const created = await create(srv.baseUrl, list.sid, TY.DPM, { "m2m:dpm": { rn, moid: model.ri } });
  assert.equal(created.rsc, "2001");

  const got = await retrieve(srv.baseUrl, `${list.sid}/${rn}`);
  assert.equal(got.body["m2m:dpm"].moid, model.ri);
  const gotModel = await retrieve(srv.baseUrl, model.sid);
  assert.equal(gotModel.rsc, "2000", "modelID must point to a resource that actually exists");
});

test("TC_TR0071_DPL_NTF_001: TP/TR-0071/CSE/DPL/NTF/001 — creating a <modelDeployment> notifies a subscriber of the list", async () => {
  // TR-0071:7.1.2.4 overview: "An ML AE ... is expected to subscribe to the parent
  // <modelDeploymentList> resource for the newly created <modelDeployment> resource." The
  // subscription/notification mechanism itself is the generic TS-0001 one (<subscription> is a
  // common child, table 7.1.2.4-1); this test only checks that TR-0071's own flow uses it.
  const sink = await startSink();
  try {
    const list = await makeDeploymentList();
    const sub = await create(srv.baseUrl, list.sid, 23,
      { "m2m:sub": { rn: uniqueRn("s"), nu: [sink.url], enc: { net: [3], chty: [TY.DPM] } } });
    assert.equal(sub.rsc, "2001");

    await create(srv.baseUrl, list.sid, TY.DPM, { "m2m:dpm": { rn: uniqueRn("dpm") } });

    const noti = await sink.waitFor((i) => i.body && i.body["m2m:sgn"]);
    const rep = noti.body["m2m:sgn"].nev.rep;
    assert.ok(rep["m2m:dpm"], `notification should carry the created <modelDeployment>: ${JSON.stringify(rep).slice(0, 200)}`);
  } finally {
    await sink.stop();
  }
});
