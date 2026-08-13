"use strict";
// TR-0071 AI/ML end-to-end scenarios.
//
// test/ai-model-management.test.js and test/ai-dataset-management.test.js each check one
// attribute or one state transition in isolation. Neither can catch what only shows up once
// resources are wired to each other: that a <modelDeployment>'s modelID resolves to a real
// <mlModel> created earlier, that a <modelDeploymentList>'s three counters add up correctly
// across several deployments, or that the policy -> dataset -> fragment chain actually links.
// This file is that layer.
//
// These scenarios are not invented. Five of the eight below (SCN/MDL/001, SCN/MDL/002,
// SCN/DST/001, SCN/DST/002, SCN/E2E/001) are transcriptions of oneM2M TR-0068's normal flows
// (clauses 7.7.6, 7.8.1, 7.8.6, 7.8.7) -- the use cases that are the reason <modelRepo>,
// <mlModel>, <modelDeploymentList>, <modelDeployment>, <mlDatasetPolicy>, <dataset> and
// <datasetFragment> exist at all. Every step below carries a comment naming the TR-0068 clause
// and step number it implements. The other three (SCN/MDL/003, SCN/DPL/001, SCN/MDL/004) have
// no TR-0068 flow behind them and say so explicitly, rather than let a made-up step number read
// like a citation -- see features/test-purposes/TR-0071.md's own framing note about not letting
// an invented identifier read like a conformance reference.
//
// Identifiers, short names and the { todo: true } divergence policy are exactly as described in
// test/ai-model-management.test.js's header (development repository, mobius4-dev-tool,
// features/test-purposes/TR-0071.md's SCN section). One thing is specific to this file:
//
// AE identity. task-11/12 (test/ai-model-management.test.js) deliberately avoided nesting
// anything under an <AE>, because registering one with an empty originator assigns it a fresh
// AE-ID as its own creator (int_cr) -- and the default test originator (ADMIN) can then fail to
// create children under that AE, since access control falls back to comparing the requesting
// originator against the resource's creator once no acpi is set (cse/hostingCSE.js's Case D).
// These scenarios cannot avoid <AE> the way the atomic tests did -- TR-0068's flows are written
// around a device (or application) AE that owns its own input/output <container>s and
// <modelDeploymentList>. The fix used throughout this file: register the AE with an empty
// originator to get its assigned AE-ID (ae.aei below), then send every subsequent request in
// that AE's subtree -- containers, the deployment list, its subscription, the deployment itself
// -- as that same aei. Creator and requester always match, so the fallback grants access, and it
// is also just what a real device authenticating as itself would do. <modelRepo>/<mlModel>
// creation and discovery stay under <CSEBase> with the default ADMIN originator, matching the
// atomic tests, since TR-0068 does not tie the repository to a specific AE.
//
// A scenario blocked by a known implementation defect (dataset-management.test.js's header lists
// the two that matter here: cse/datasetManager.js's create_a_live_dataset throws a
// ReferenceError on every live-dataset create, and custodian propagation cannot even be
// attempted because the create schema rejects the attribute outright) is still written out in
// full, step by step, exactly as TR-0068 describes it -- the failing step, and the assertion
// message naming it, is the evidence. Nothing here is worked around or truncated to make the
// suite look greener than the implementation is.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, retrieve, update, remove, discover, uniqueRn, urils, CSE_BASE } = require("./helpers/onem2m");
const { startSink } = require("./helpers/noti-sink");

const TY = { AE: 2, CNT: 3, CIN: 4, SUB: 23, MRP: 101, MMD: 102, MDP: 103, DPM: 104, DSP: 105, DTS: 106, DSF: 107 };

let srv;
before(async () => { srv = await startServer(); });
after(async () => { if (srv) await srv.stop(); });

// -------------------------------------------------------------------------------------------
// Fixture helpers. Where a helper corresponds directly to a numbered TR-0068 step (repository
// creation, model registration, policy creation), it does NOT assert on the outcome itself --
// the calling test does that, with a message naming the step, so a failure points at the right
// place instead of a generic "setup failed". Helpers that are pure pre-condition scaffolding
// (registering an AE, giving it a container) assert internally, since TR-0068 does not number
// them as steps of the flow under test.
// -------------------------------------------------------------------------------------------

// Registers an <AE> with no pre-assigned identity (TS-0001 self-registration) and returns the
// AE-ID the CSE assigned. Every subsequent request into this AE's subtree must be sent with
// { originator: ae.originator } -- see the file header.
async function makeAe(prefix) {
  const rn = uniqueRn(prefix);
  const res = await create(srv.baseUrl, CSE_BASE, TY.AE,
    { "m2m:ae": { rn, api: "Nscn.test", rr: false, srv: ["3"] } }, { originator: "" });
  assert.equal(res.rsc, "2001", `pre-condition: registering the <AE> failed: ${res.raw.slice(0, 200)}`);
  const aei = res.body["m2m:ae"].aei;
  return { rn, sid: `${CSE_BASE}/${rn}`, aei, originator: aei };
}

async function makeContainer(parentSid, prefix, originator) {
  const rn = uniqueRn(prefix);
  const res = await create(srv.baseUrl, parentSid, TY.CNT, { "m2m:cnt": { rn } }, { originator });
  assert.equal(res.rsc, "2001", `pre-condition: <container> create under ${parentSid} failed: ${res.raw.slice(0, 200)}`);
  return `${parentSid}/${rn}`;
}

async function makeDeploymentList(parentSid, originator) {
  const rn = uniqueRn("mdp");
  const res = await create(srv.baseUrl, parentSid, TY.MDP, { "m2m:mdp": { rn } }, { originator });
  assert.equal(res.rsc, "2001", `pre-condition: <modelDeploymentList> create under ${parentSid} failed: ${res.raw.slice(0, 200)}`);
  return { rn, sid: `${parentSid}/${rn}` };
}

// TR-0071 table 7.1.2.2-2: version/platform/mlType are multiplicity 1.
function modelBody(rn, extra = {}) {
  return { "m2m:mmd": { rn, vr: "1.0.0", plf: "scikit-learn", mlt: "regression", ...extra } };
}

async function makeRepo(extra = {}) {
  const rn = uniqueRn("mrp");
  const res = await create(srv.baseUrl, CSE_BASE, TY.MRP, { "m2m:mrp": { rn, ...extra } });
  return { rn, sid: `${CSE_BASE}/${rn}`, res, body: res.body && res.body["m2m:mrp"] };
}

async function makeModel(repoSid, extra = {}) {
  const rn = uniqueRn("mmd");
  const res = await create(srv.baseUrl, repoSid, TY.MMD, modelBody(rn, extra));
  const body = res.body && res.body["m2m:mmd"];
  return { rn, sid: `${repoSid}/${rn}`, ri: body && body.ri, res, body };
}

// A source <container> holding one <contentInstance> per value in `values`. Waits ~1.1s between
// instances: mobius4's `ct` has only second granularity, and every window/ordering computation
// in cse/datasetManager.js sorts and filters on `ct` -- same-second instances would be
// indistinguishable (same reasoning as test/ai-dataset-management.test.js's makeSource).
async function makeSource(name, values) {
  const rn = uniqueRn(name);
  const c = await create(srv.baseUrl, CSE_BASE, TY.CNT, { "m2m:cnt": { rn } });
  assert.equal(c.rsc, "2001", `pre-condition: source <container> create failed: ${c.raw.slice(0, 200)}`);
  const sid = `${CSE_BASE}/${rn}`;
  for (const v of values) {
    const res = await create(srv.baseUrl, sid, TY.CIN, { "m2m:cin": { con: v } });
    assert.equal(res.rsc, "2001", `pre-condition: <contentInstance> ${JSON.stringify(v)} under ${sid} failed: ${res.raw.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 1100));
  }
  return { rn, sid };
}

async function makePolicy(extra) {
  const rn = uniqueRn("dsp");
  const res = await create(srv.baseUrl, CSE_BASE, TY.DSP, { "m2m:dsp": { rn, dsfm: 1, ...extra } });
  return { rn, sid: `${CSE_BASE}/${rn}`, res };
}

// Wraps sink.waitFor so a timeout names the step it was waiting for, instead of just "timed out
// waiting for a notification".
async function expectNotification(sink, pred, timeoutMs, label) {
  try {
    return await sink.waitFor(pred, { timeoutMs });
  } catch (err) {
    throw new Error(`${label}: ${err.message}`);
  }
}

// -------------------------------------------------------------------------------------------
// Shared flow fragments, reused by more than one scenario below (SCN/E2E/001's own "Sequence"
// table literally says "SCN/DST/001 전체 수행" / "SCN/MDL/001의 Step 4~7 수행" -- perform DST/001
// in full, perform MDL/001's Steps 4-7 -- so this is what that reuse means in code).
// -------------------------------------------------------------------------------------------

// TR-0068:7.7.6 Steps 1-5. Used by TC_TR0071_SCN_DST_01 directly, and by TC_TR0071_SCN_E2E_01 as
// its first leg (TR-0068:7.8.1 item 1, whose own text says "The first step has been described in
// clause 7.7" -- it is this same flow, not a different one).
async function runHistoricalDatasetFlow() {
  // Step 1 (TR-0068:7.7.6 Step 1): IoT sensors send readings and the platform stores them, so
  // source <container>s accumulate <contentInstance>s. Two sensors, so Step 2's "merge several
  // sensors" has something to merge.
  const srcTemp = await makeSource("temp", [{ temperature: 21 }, { temperature: 22 }]);
  const srcHumi = await makeSource("humi", [{ humidity: 40 }, { humidity: 41 }]);

  // Step 2 (TR-0068:7.7.6 Step 2): the data scientist requests a training dataset merged from
  // several sensors -- an <mlDatasetPolicy> with sri (multiple sources) and nrhd.
  //
  // custodian is deliberately left out of this create. TR-0071:7.2.3.2 says the policy's
  // custodian should propagate to the <dataset> it creates, but TC_TR0071_DST_CRE_002 (in
  // test/ai-dataset-management.test.js) already established that including `cst` in the request
  // gets the *entire* create rejected outright -- dsp_create_schema
  // (cse/validation/res_schema.js) has no `cst` key and no `.unknown(true)`, so the request never
  // even reaches the point where custodian propagation could be attempted. Repeating that here
  // would abort every step below and defeat what this scenario exists to check: that the
  // policy -> dataset -> fragment chain actually links. That already-documented, already-todo
  // failure is not re-run inside this scenario.
  const policy = await makePolicy({ sri: [srcTemp.sid, srcHumi.sid], nrhd: 100 });
  assert.equal(policy.res.rsc, "2001",
    `Step 2 (TR-0068:7.7.6): <mlDatasetPolicy> create failed: ${policy.res.raw.slice(0, 200)}`);
  const dsp = policy.res.body["m2m:dsp"];
  assert.ok(dsp.hdi, `Step 2 (TR-0068:7.7.6): historicalDatasetID was not set: ${JSON.stringify(dsp)}`);

  // Step 3 (TR-0068:7.7.6 Step 3): "the platform generates the training dataset" using its join
  // policy -- TR-0071's actual mechanism is sri plus the time-correlation window (tcst/tcd, left
  // at their defaults here), which merges same-window readings from different sources.
  const dtsSid = dsp.hdi;
  const frags = urils(await discover(srv.baseUrl, dtsSid, { ty: String(TY.DSF) }));
  assert.ok(frags.length > 0, `Step 3 (TR-0068:7.7.6): expected at least one <datasetFragment> under ${dtsSid}, found none`);

  // Step 4 (TR-0068:7.7.6 Step 4): "the generated dataset is retrieved in the specified format".
  // TR-0071 itself notes CSV is not yet an oneM2M serialization (7.2.2.1/7.2.2.3), so this reads
  // it back as the JSON resource representation (m2m:dsf) instead.
  let totalRows = 0;
  for (const f of frags) {
    const dsf = (await retrieve(srv.baseUrl, f)).body["m2m:dsf"];
    assert.ok(dsf, `Step 4 (TR-0068:7.7.6): <datasetFragment> ${f} did not retrieve`);
    assert.ok(dsf.dfst && dsf.dfet && dsf.dfst <= dsf.dfet,
      `Step 4 (TR-0068:7.7.6): datasetFragmentStartTime/EndTime should bound fragment ${f}, got dfst=${dsf.dfst} dfet=${dsf.dfet}`);
    assert.equal(dsf.nrf, dsf.dsfr.length,
      `Step 4 (TR-0068:7.7.6): numberOfRowsInFragment should match the row count on fragment ${f}`);
    totalRows += dsf.nrf;
  }

  // Step 5 (TR-0068:7.7.6 Step 5): "the data scientist builds an AI/ML model from the dataset and
  // deploys it to an application". This is outside the CSE -- TR-0071 defines no attribute
  // linking a <mlModel> back to the <dataset> it was trained on -- so there is nothing to assert
  // here. It is the handoff TC_TR0071_SCN_E2E_01 picks up as its own item 2.
  return { dtsSid, totalRows };
}

// TR-0068:7.8.6 Steps 4-7. Used by TC_TR0071_SCN_MDL_01 directly, and by TC_TR0071_SCN_E2E_01 as
// its last leg (TR-0068:7.8.1 item 3, whose own text says "the use case in this clause [7.8.6]
// describes how the third step can be done").
async function runDeployAndInferFlow(sink, model) {
  const ae = await makeAe("dev");
  const inSid = await makeContainer(ae.sid, "in", ae.originator);
  const outSid = await makeContainer(ae.sid, "out", ae.originator);
  const list = await makeDeploymentList(ae.sid, ae.originator);

  // Pre-condition (TR-0068:7.8.4): "The IoT device subscribes its model deployment resource, so
  // it can get the deployment information."
  const sub = await create(srv.baseUrl, list.sid, TY.SUB,
    { "m2m:sub": { rn: uniqueRn("sub"), nu: [sink.url], enc: { net: [3], chty: [TY.DPM] } } },
    { originator: ae.originator });
  assert.equal(sub.rsc, "2001",
    `pre-condition (TR-0068:7.8.4): the device could not subscribe to its <modelDeploymentList>: ${sub.raw.slice(0, 200)}`);

  // Step 4 (TR-0068:7.8.6): the provider deploys the selected model to the device.
  const dep = await create(srv.baseUrl, list.sid, TY.DPM,
    { "m2m:dpm": { rn: uniqueRn("dpm"), moid: model.ri, inr: inSid, our: outSid } },
    { originator: ae.originator });
  assert.equal(dep.rsc, "2001", `Step 4 (TR-0068:7.8.6): <modelDeployment> create failed: ${dep.raw.slice(0, 200)}`);
  assert.equal(dep.body["m2m:dpm"].mds, 0,
    "Step 4 (TR-0068:7.8.6): a freshly created <modelDeployment> should default to modelStatus=0 (deployed)");
  const depSid = `${list.sid}/${dep.body["m2m:dpm"].rn}`;
  const gotModel = await retrieve(srv.baseUrl, model.sid);
  assert.equal(gotModel.rsc, "2000",
    "Step 4 (TR-0068:7.8.6): modelID should resolve to a real <mlModel> (TP/TR-0071/CSE/DPL/RET/001)");

  // Step 5 (TR-0068:7.8.6): the platform notifies the device about the deployment.
  const noti = await expectNotification(sink,
    (i) => i.body && i.body["m2m:sgn"] && i.body["m2m:sgn"].nev.rep["m2m:dpm"],
    5000, "Step 5 (TR-0068:7.8.6)");
  assert.ok(noti.body["m2m:sgn"].nev.rep["m2m:dpm"], "Step 5 (TR-0068:7.8.6): notification should carry the new <modelDeployment>");

  // Step 6 (TR-0068:7.8.6): sensor data lands in the input container, then the device is told to
  // run the model against it.
  const cinIn = await create(srv.baseUrl, inSid, TY.CIN, { "m2m:cin": { con: { temperature: 21.5 } } }, { originator: ae.originator });
  assert.equal(cinIn.rsc, "2001", `Step 6 (TR-0068:7.8.6): storing the sensor reading failed: ${cinIn.raw.slice(0, 200)}`);
  const run = await update(srv.baseUrl, depSid, { "m2m:dpm": { mcmd: 1 } }, { originator: ae.originator });
  assert.equal(run.rsc, "2004", `Step 6 (TR-0068:7.8.6): modelCommand=1 (run) update failed: ${run.raw.slice(0, 200)}`);
  assert.equal(run.body["m2m:dpm"].mds, 1, "Step 6 (TR-0068:7.8.6): modelStatus should move to 1 (running) after modelCommand=1");

  // Step 7 (TR-0068:7.8.6): the device stores the inference result in the output container.
  const cinOut = await create(srv.baseUrl, outSid, TY.CIN, { "m2m:cin": { con: { pred: 0.83 } } }, { originator: ae.originator });
  assert.equal(cinOut.rsc, "2001", `Step 7 (TR-0068:7.8.6): storing the inference result failed: ${cinOut.raw.slice(0, 200)}`);
  const gotLatest = await retrieve(srv.baseUrl, `${outSid}/la`, { originator: ae.originator });
  assert.equal(gotLatest.rsc, "2000", "Step 7 (TR-0068:7.8.6): the inference result should be readable back via <latest>");

  return { listSid: list.sid, depSid, originator: ae.originator };
}

// -------------------------------------------------------------------------------------------
// SCN/MDL -- model registry / deployment scenarios
// -------------------------------------------------------------------------------------------

test("TC_TR0071_SCN_MDL_01: TP/TR-0071/CSE/SCN/MDL/001 — model registry to on-device inference", async () => {
  // TR-0068:7.8.6, Steps 1-7 (the clause has exactly seven, per features/test-purposes/TR-0071.md's
  // own note that it measured this directly against the corpus).
  const sink = await startSink();
  try {
    // Step 1 (TR-0068:7.8.6 Step 1): the data scientist creates a model repository.
    const repo = await makeRepo();
    assert.equal(repo.res.rsc, "2001", `Step 1 (TR-0068:7.8.6): <modelRepo> create failed: ${repo.res.raw.slice(0, 200)}`);
    assert.equal(repo.body.cnmo, 0, "Step 1 (TR-0068:7.8.6): a fresh <modelRepo> should report zero models");

    // Step 2 (TR-0068:7.8.6 Step 2): the data scientist registers a model.
    const model = await makeModel(repo.sid);
    assert.equal(model.res.rsc, "2001", `Step 2 (TR-0068:7.8.6): <mlModel> registration failed: ${model.res.raw.slice(0, 200)}`);
    const repoAfter = (await retrieve(srv.baseUrl, repo.sid)).body["m2m:mrp"];
    assert.equal(repoAfter.cnmo, 1, "Step 2 (TR-0068:7.8.6): registering a model should increment the parent's currentNumberOfModels");

    // Step 3 (TR-0068:7.8.6 Step 3): the AI service provider looks at what is in the repository
    // and picks one, by discovery under the <modelRepo>.
    const found = urils(await discover(srv.baseUrl, repo.sid, { ty: String(TY.MMD) }));
    assert.ok(found.some((u) => u.includes(model.rn)),
      `Step 3 (TR-0068:7.8.6): the registered model should be discoverable under its <modelRepo>, got ${JSON.stringify(found)}`);

    // Steps 4-7 (TR-0068:7.8.6): deploy the selected model to a device that has subscribed to its
    // deployment list, run it, and store the result. Shared with TC_TR0071_SCN_E2E_01's item 3.
    const { listSid, originator } = await runDeployAndInferFlow(sink, model);

    // Post-conditions: numberOfRunningModels=1, numberOfDeployedModels=0, numberOfStoppedModels=0.
    // (These three always sum to the number of <modelDeployment> children -- here 1.)
    const list = (await retrieve(srv.baseUrl, listSid, { originator })).body["m2m:mdp"];
    assert.equal(list.nrm, 1, "post-condition (TR-0068:7.8.6): numberOfRunningModels");
    assert.equal(list.ndm, 0, "post-condition (TR-0068:7.8.6): numberOfDeployedModels");
    assert.equal(list.nsm, 0, "post-condition (TR-0068:7.8.6): numberOfStoppedModels");
  } finally {
    await sink.stop();
  }
});

test("TC_TR0071_SCN_MDL_02: TP/TR-0071/CSE/SCN/MDL/002 — alternative flow: deploy to a cloud inference application", async () => {
  // TR-0068:7.8.7 Alternative Flow. The clause itself carries no step numbers -- it is one
  // paragraph: "the target of model deployment is basically applications ... the alternative flow
  // to the main flow above is to deploy an AI model to AIoT applications (e.g. AI inference server
  // on cloud computing environment)." The step mapping below (7.8.6's Step 1-7 skeleton with
  // 7.8.7's target substituted in) is this document's own construction, not numbering 7.8.7 gives
  // directly -- see features/test-purposes/TR-0071.md's note under this TP for the same caveat.
  const sink = await startSink();
  try {
    // Step 1 (7.8.6 Steps 1-3, unchanged): model repository, registration, discovery -- identical
    // in substance to TC_TR0071_SCN_MDL_01's Steps 1-3.
    const repo = await makeRepo();
    assert.equal(repo.res.rsc, "2001", `Step 1 (7.8.6 Steps 1-3): <modelRepo> create failed: ${repo.res.raw.slice(0, 200)}`);
    const model = await makeModel(repo.sid);
    assert.equal(model.res.rsc, "2001", `Step 1 (7.8.6 Steps 1-3): <mlModel> registration failed: ${model.res.raw.slice(0, 200)}`);
    const found = urils(await discover(srv.baseUrl, repo.sid, { ty: String(TY.MMD) }));
    assert.ok(found.some((u) => u.includes(model.rn)),
      `Step 1 (7.8.6 Steps 1-3): registered model not discoverable, got ${JSON.stringify(found)}`);

    // The target is a cloud inference application <AE>, not an IoT device -- TR-0071 gives <AE>
    // no attribute distinguishing the two (see the "주의" note under this TP in
    // features/test-purposes/TR-0071.md), so this is just a second <AE> with its own containers
    // and a subscribed <modelDeploymentList>, exactly as SCN/MDL/001's pre-condition (TR-0068:7.8.4)
    // describes for a device.
    const cloudAe = await makeAe("cloud");
    const inSid = await makeContainer(cloudAe.sid, "in", cloudAe.originator);
    const outSid = await makeContainer(cloudAe.sid, "out", cloudAe.originator);
    const list = await makeDeploymentList(cloudAe.sid, cloudAe.originator);
    const sub = await create(srv.baseUrl, list.sid, TY.SUB,
      { "m2m:sub": { rn: uniqueRn("sub"), nu: [sink.url], enc: { net: [3], chty: [TY.DPM] } } },
      { originator: cloudAe.originator });
    assert.equal(sub.rsc, "2001",
      `pre-condition (TR-0068:7.8.4, applied to the cloud application): subscription to its <modelDeploymentList> failed: ${sub.raw.slice(0, 200)}`);

    // Step 2 (7.8.6 Step 4 + 7.8.7 target substitution): deploy the selected model, this time to
    // the cloud application's containers instead of a device's.
    const dep = await create(srv.baseUrl, list.sid, TY.DPM,
      { "m2m:dpm": { rn: uniqueRn("dpm"), moid: model.ri, inr: inSid, our: outSid } },
      { originator: cloudAe.originator });
    assert.equal(dep.rsc, "2001", `Step 2 (7.8.6 Step 4 + 7.8.7): <modelDeployment> create failed: ${dep.raw.slice(0, 200)}`);
    assert.equal(dep.body["m2m:dpm"].mds, 0,
      "Step 2 (7.8.6 Step 4 + 7.8.7): a freshly created <modelDeployment> should default to modelStatus=0 (deployed)");
    const depSid = `${list.sid}/${dep.body["m2m:dpm"].rn}`;

    // Step 3 (7.8.6 Step 5, unchanged): the subscription notification reaches the cloud
    // application instead of a physical device.
    const noti = await expectNotification(sink,
      (i) => i.body && i.body["m2m:sgn"] && i.body["m2m:sgn"].nev.rep["m2m:dpm"],
      5000, "Step 3 (7.8.6 Step 5)");
    assert.ok(noti.body["m2m:sgn"].nev.rep["m2m:dpm"], "Step 3 (7.8.6 Step 5): notification should carry the new <modelDeployment>");

    // Step 4 (7.8.6 Step 6 + 7.8.7 target substitution): the cloud application reads the input
    // container and runs the model itself (rather than a physical device doing so).
    const cinIn = await create(srv.baseUrl, inSid, TY.CIN, { "m2m:cin": { con: { batch: 1 } } }, { originator: cloudAe.originator });
    assert.equal(cinIn.rsc, "2001", `Step 4 (7.8.6 Step 6 + 7.8.7): storing inference input failed: ${cinIn.raw.slice(0, 200)}`);
    const run = await update(srv.baseUrl, depSid, { "m2m:dpm": { mcmd: 1 } }, { originator: cloudAe.originator });
    assert.equal(run.rsc, "2004", `Step 4 (7.8.6 Step 6 + 7.8.7): modelCommand=1 (run) update failed: ${run.raw.slice(0, 200)}`);
    assert.equal(run.body["m2m:dpm"].mds, 1, "Step 4 (7.8.6 Step 6 + 7.8.7): modelStatus should move to 1 (running)");

    // Step 5 (7.8.6 Step 7, target substitution): the application stores the inference result.
    const cinOut = await create(srv.baseUrl, outSid, TY.CIN, { "m2m:cin": { con: { pred: 0.5 } } }, { originator: cloudAe.originator });
    assert.equal(cinOut.rsc, "2001", `Step 5 (7.8.6 Step 7): storing the inference result failed: ${cinOut.raw.slice(0, 200)}`);
    const gotLatest = await retrieve(srv.baseUrl, `${outSid}/la`, { originator: cloudAe.originator });
    assert.equal(gotLatest.rsc, "2000", "Step 5 (7.8.6 Step 7): the inference result should be readable back via <latest>");

    // Post-conditions: same counter invariant as SCN/MDL/001.
    const listAfter = (await retrieve(srv.baseUrl, list.sid, { originator: cloudAe.originator })).body["m2m:mdp"];
    assert.equal(listAfter.nrm, 1, "post-condition: numberOfRunningModels");
    assert.equal(listAfter.ndm, 0, "post-condition: numberOfDeployedModels");
    assert.equal(listAfter.nsm, 0, "post-condition: numberOfStoppedModels");
  } finally {
    await sink.stop();
  }
});

test("TC_TR0071_SCN_MDL_03: TP/TR-0071/CSE/SCN/MDL/003 — repeated capacity eviction keeps the repository at its cap", async () => {
  // No corresponding flow in TR-0068 — derived from the TR-0071 attribute table
  // (maxNumberOfModels, TR-0071:7.1.2.1) plus project decision B-2 (docs/tr-0071-revision-
  // proposal.md): an over-cap create evicts the oldest sibling rather than being rejected. This
  // extends TC_TR0071_MDL_CRE_006 (a single eviction, in test/ai-model-management.test.js) to two
  // evictions back to back, to check the cap holds under repeated pressure and not just once.
  const repo = await makeRepo({ mnmo: 2 });
  assert.equal(repo.res.rsc, "2001", `setup: <modelRepo> create failed: ${repo.res.raw.slice(0, 200)}`);
  const mmdA = await makeModel(repo.sid);
  assert.equal(mmdA.res.rsc, "2001", `setup: creating mmdA failed: ${mmdA.res.raw.slice(0, 200)}`);
  // find_edge_mmd (cse/resources/mmd.js) breaks a creationTime tie by `ri` ASC, and `ri` comes
  // from a random ID generator (cse/utils.js's generate_ri, nanoid-based) with no time
  // correlation. mobius4's `ct` has only second granularity (config/default.json
  // "timestamp_format": "YYYYMMDDTHHmmss"), so two creates in the same second tie on `ct` and the
  // "oldest" pick becomes an effectively random choice between them -- invisible in
  // TC_TR0071_MDL_CRE_006 (test/ai-model-management.test.js), which only ever has one eviction
  // candidate at a time, but real here: mmdA and mmdB are both pre-existing candidates when mmdC
  // triggers the eviction below, so a tie between them would make this test flaky rather than
  // wrong. The 1.1s wait (same reasoning as test/ai-dataset-management.test.js's makeSource)
  // guarantees mmdA really is older than mmdB by `ct`, not just by insertion order.
  await new Promise((r) => setTimeout(r, 1100));
  const mmdB = await makeModel(repo.sid);
  assert.equal(mmdB.res.rsc, "2001", `setup: creating mmdB failed: ${mmdB.res.raw.slice(0, 200)}`);

  // Step 1: a third model pushes the repository one over its cap of 2.
  const mmdC = await makeModel(repo.sid);
  assert.equal(mmdC.res.rsc, "2001", `Step 1: creating the third <mlModel> (mmdC) failed: ${mmdC.res.raw.slice(0, 200)}`);

  // Step 2: the oldest (mmdA) should have been evicted.
  const gotA = await retrieve(srv.baseUrl, mmdA.sid);
  assert.equal(gotA.rsc, "4004", "Step 2: the oldest <mlModel> (mmdA) should have been evicted after the third create");

  // Step 3: the two survivors are still there.
  const gotB = await retrieve(srv.baseUrl, mmdB.sid);
  assert.equal(gotB.rsc, "2000", "Step 3: mmdB should have survived the eviction that mmdC's creation triggered");
  const gotC = await retrieve(srv.baseUrl, mmdC.sid);
  assert.equal(gotC.rsc, "2000", "Step 3: mmdC (the model whose creation triggered the eviction) should exist");

  // Step 4: the parent's count stays at the cap, neither below nor above it.
  const gotRepo = await retrieve(srv.baseUrl, repo.sid);
  assert.equal(gotRepo.body["m2m:mrp"].cnmo, 2,
    "Step 4: currentNumberOfModels should sit exactly at maxNumberOfModels (2) after the eviction, not drift");
});

// TP/TR-0071/CSE/SCN/MDL/004: no corresponding flow in TR-0068, and — unlike every other test in
// this file — no defined expected result either. <modelDeployment>.modelID has no update path
// (TC_TR0071_DPL_UPD_005, test/ai-model-management.test.js: moid is immutable, together with
// modelStatus), and neither TR-0071 nor TR-0068 defines a "replace the deployed model" procedure
// at all. Per the owner's rule for a genuinely unclear case, this stays { todo: true } rather
// than assert an outcome nobody has specified -- inventing one would misrepresent an open design
// gap as a conformance requirement. See docs/tr-0071-revision-proposal.md B-3 for the adjacent,
// also-open question of what a <modelDeployment> becomes once the <mlModel> it references is
// evicted or deleted -- Step 3 below is exactly that case, one step removed from "replacement".
test("TC_TR0071_SCN_MDL_04: TP/TR-0071/CSE/SCN/MDL/004 — replacing a deployed model's version is undefined", { todo: true }, async () => {
  const repo = await makeRepo();
  assert.equal(repo.res.rsc, "2001", `setup: <modelRepo> create failed: ${repo.res.raw.slice(0, 200)}`);
  const mmd1 = await makeModel(repo.sid, { vr: "1.0" });
  assert.equal(mmd1.res.rsc, "2001", `setup: registering mmd1 (vr=1.0) failed: ${mmd1.res.raw.slice(0, 200)}`);
  const list = await makeDeploymentList(CSE_BASE);
  const dep = await create(srv.baseUrl, list.sid, TY.DPM, { "m2m:dpm": { rn: uniqueRn("dpm"), moid: mmd1.ri } });
  assert.equal(dep.rsc, "2001", `setup: <modelDeployment> create failed: ${dep.raw.slice(0, 200)}`);
  const depSid = `${list.sid}/${dep.body["m2m:dpm"].rn}`;
  const started = await update(srv.baseUrl, depSid, { "m2m:dpm": { mcmd: 1 } }); // deployed -> running
  assert.equal(started.rsc, "2004", `setup: starting the deployment (mcmd=1) failed: ${started.raw.slice(0, 200)}`);

  // Step 1: registering a new version of the same model is a defined operation.
  // TP/TR-0071/CSE/MDL/CRE/002 only requires vr/plf/mlt to be present -- it does not enforce
  // version uniqueness within a repository -- so the old and new versions simply coexist as
  // separate <mlModel> resources.
  const mmd2 = await makeModel(repo.sid, { vr: "2.0" });
  assert.equal(mmd2.res.rsc, "2001", `Step 1: registering the new model version (mmd2, vr=2.0) failed: ${mmd2.res.raw.slice(0, 200)}`);
  const gotMmd1 = await retrieve(srv.baseUrl, mmd1.sid);
  assert.equal(gotMmd1.rsc, "2000", "Step 1: the old version (mmd1) should still exist alongside the new one (mmd2)");

  // Step 2: "replace" is not itself a defined operation. The only mechanism TR-0071 gives for
  // pointing an existing <modelDeployment> at a different <mlModel> is UPDATE-ing modelID, and
  // that path is already established as rejected (TC_TR0071_DPL_UPD_005: moid is immutable). This
  // confirms the naive path does not work; it says nothing about what the correct path is meant
  // to be, because TR-0071 specifies none.
  const naiveReplace = await update(srv.baseUrl, depSid, { "m2m:dpm": { moid: mmd2.ri } });
  assert.equal(naiveReplace.rsc, "4000",
    `Step 2: expected the naive UPDATE-modelID path to be rejected as immutable (as TC_TR0071_DPL_UPD_005 already establishes), got rsc=${naiveReplace.rsc}: ${naiveReplace.raw.slice(0, 200)}`);

  // Step 3: what should dep1 become once mmd1 (the model it still references) is deleted? Neither
  // TR-0071 nor the revision proposal's B-3 answers this (B-3 names the eviction case explicitly;
  // a direct client DELETE raises the identical question). No assertion is made on purpose --
  // inventing an expected mds/moid value here would misrepresent an open design question as a
  // passing test. The delete is still carried out, so a reader re-running this file with
  // { todo: true } removed can see the actual (unspecified) resulting state for themselves.
  await remove(srv.baseUrl, mmd1.sid);
});

// -------------------------------------------------------------------------------------------
// SCN/DST -- dataset scenarios
// -------------------------------------------------------------------------------------------

test("TC_TR0071_SCN_DST_01: TP/TR-0071/CSE/SCN/DST/001 — historical data to a trained-model handoff", async () => {
  const { dtsSid, totalRows } = await runHistoricalDatasetFlow();

  // Post-conditions: one historical <dataset>, at least one <datasetFragment>, and the fragments'
  // row counts sum to the number of source instances that passed the time-window filter -- here,
  // none were excluded (TC_TR0071_DST_CRE_007 already establishes that an absent dst/det includes
  // every source instance), so the sum should be all 4 (2 sensors x 2 readings each).
  const dts = (await retrieve(srv.baseUrl, dtsSid)).body["m2m:dts"];
  assert.equal(dts.ty, TY.DTS, "post-condition (TR-0068:7.7.6): historicalDatasetID should resolve to a <dataset>");
  assert.equal(totalRows, 4,
    "post-condition (TR-0068:7.7.6): the fragment row counts should sum to all 4 source instances (2 sensors x 2 readings)");
});

// TP/TR-0071/CSE/SCN/DST/002: TR-0068:7.7.6 Steps 6-9, the live-data half of the flow that
// TC_TR0071_SCN_DST_01 covers historically. Was blocked at Step 6, then Step 7; now blocked at
// Step 8, for a reason an MQTT fixture would not fix either.
//
// FIXED 2026-08-14: two prior blockers are resolved. BACKLOG-092 (cse/datasetManager.js's
// `dsp_ri` referenced outside the callback scope that defines it, in create_a_live_dataset) was
// blocking Step 6 -- every live-dataset policy create threw a synchronous ReferenceError, which
// create_a_dsp's catch reported as a generic 4000. BACKLOG-094 (cse/resources/sub.js's
// sub_parent_res_types missing "dsp" and "dts") was blocking Step 7 -- a <subscription> under a
// <dataset> came back 5203 (TARGET_NOT_SUBSCRIBABLE). Both are fixed; Steps 6 and 7 below now
// pass.
//
// FAILS 2026-08-14 at Step 8: the periodic collector never creates a <datasetFragment> in this
// harness, because it runs with mqtt.enabled=false (test/helpers/server.js's startServer() only
// enables mqtt when a caller passes mqttPort, which this file's `before` hook does not) and the
// live-collection path batches newly-arrived sensor data via the MQTT binding (cse/noti.js's
// self_noti_handler, only invoked from bindings/mqtt.js) into datasetManager.js's batch_data[].
// But verified by hand outside this harness (real mobius4 process + real mosquitto broker on the
// port cse/datasetManager.js:329 hard-codes) that fixing only the MQTT gap would still not get
// Step 9 to pass: the <datasetFragment> for Step 8 *does* get created once MQTT works, but the
// Step 9 notification never arrives, because create_a_live_dsf creates it by calling
// cse/resources/dsf.js's create_a_dsf(...) directly -- and CREATE notifications are only ever
// sent from cse/hostingCSE.js's create_a_res (`noti.check_and_send_noti(...)`, right after the
// same dispatch call), which datasetManager.js bypasses entirely. This is a third, independent
// gap (not BACKLOG-092, not BACKLOG-094, not covered by the revision proposal), documented in
// full at TC_TR0071_DST_NTF_001 (test/ai-dataset-management.test.js).
test("TC_TR0071_SCN_DST_02: TP/TR-0071/CSE/SCN/DST/002 — live path notifies a subscriber of new fragments", { todo: true }, async () => {
  const src = await makeSource("live-src", [{ v: 0 }]);

  // Step 6 (TR-0068:7.7.6 Step 6): "the data scientist requests inference input data" (with a
  // policy) -- TR-0071 realizes this as a live <dataset>, created via numberOfRowsForLiveDataset.
  const policy = await makePolicy({ sri: [src.sid], nrld: 1, tcd: 2 });
  assert.equal(policy.res.rsc, "2001",
    `Step 6 (TR-0068:7.7.6): expected the live <mlDatasetPolicy> to be created with a liveDatasetID, got rsc=${policy.res.rsc}: ${policy.res.raw.slice(0, 200)}`);
  const dtsSid = policy.res.body["m2m:dsp"].ldi;
  assert.ok(dtsSid, `Step 6 (TR-0068:7.7.6): liveDatasetID was not set: ${JSON.stringify(policy.res.body["m2m:dsp"])}`);

  // Step 7 (TR-0068:7.7.6 Step 7): the data scientist subscribes to the inference data container
  // (the live <dataset>) for new <datasetFragment>s.
  const sink = await startSink();
  try {
    const sub = await create(srv.baseUrl, dtsSid, TY.SUB,
      { "m2m:sub": { rn: uniqueRn("s"), nu: [sink.url], enc: { net: [3], chty: [TY.DSF] } } });
    assert.equal(sub.rsc, "2001", `Step 7 (TR-0068:7.7.6): subscription to the live <dataset> failed: ${sub.raw.slice(0, 200)}`);

    // Step 8 (TR-0068:7.7.6 Step 8): the platform periodically collects new sensor data into a
    // new <datasetFragment>, per the Step 6 policy.
    const newReading = await create(srv.baseUrl, src.sid, TY.CIN, { "m2m:cin": { con: { v: 1 } } });
    assert.equal(newReading.rsc, "2001", `Step 8 (TR-0068:7.7.6): storing a new sensor reading failed: ${newReading.raw.slice(0, 200)}`);
    const frags = urils(await discover(srv.baseUrl, dtsSid, { ty: String(TY.DSF) }));
    assert.ok(frags.length > 0, "Step 8 (TR-0068:7.7.6): expected the periodic collector to have created at least one <datasetFragment>");

    // Step 9 (TR-0068:7.7.6 Step 9): the Step 7 subscriber is notified of the new fragment.
    const noti = await expectNotification(sink,
      (i) => i.body && i.body["m2m:sgn"] && i.body["m2m:sgn"].nev.rep["m2m:dsf"],
      8000, "Step 9 (TR-0068:7.7.6)");
    assert.ok(noti.body["m2m:sgn"].nev.rep["m2m:dsf"], "Step 9 (TR-0068:7.7.6): notification should carry the new <datasetFragment>");
  } finally {
    await sink.stop();
  }
});

// -------------------------------------------------------------------------------------------
// SCN/DPL -- deployment-list counter scenario
// -------------------------------------------------------------------------------------------

test("TC_TR0071_SCN_DPL_01: TP/TR-0071/CSE/SCN/DPL/001 — three deployments, mixed run/stop, counters still sum to the child count", async () => {
  // No corresponding flow in TR-0068 — derived from the TR-0071 attribute table
  // (TR-0071:7.1.3.4, "the Hosting CSE shall update ... numberOfDeployedModels,
  // numberOfRunningModels, numberOfStoppedModels ... as well"). This extends
  // TC_TR0071_DPL_UPD_003 (test/ai-model-management.test.js: one deployment, sum=1) to three
  // deployments in different states, to catch a bookkeeping error that only shows up once deltas
  // of both signs have been applied.
  const list = await makeDeploymentList(CSE_BASE);
  const dpm1 = await create(srv.baseUrl, list.sid, TY.DPM, { "m2m:dpm": { rn: uniqueRn("dpm") } });
  assert.equal(dpm1.rsc, "2001", `setup: creating dpm1 failed: ${dpm1.raw.slice(0, 200)}`);
  const dpm2 = await create(srv.baseUrl, list.sid, TY.DPM, { "m2m:dpm": { rn: uniqueRn("dpm") } });
  assert.equal(dpm2.rsc, "2001", `setup: creating dpm2 failed: ${dpm2.raw.slice(0, 200)}`);
  const dpm3 = await create(srv.baseUrl, list.sid, TY.DPM, { "m2m:dpm": { rn: uniqueRn("dpm") } });
  assert.equal(dpm3.rsc, "2001", `setup: creating dpm3 failed: ${dpm3.raw.slice(0, 200)}`);
  const sid1 = `${list.sid}/${dpm1.body["m2m:dpm"].rn}`;
  const sid2 = `${list.sid}/${dpm2.body["m2m:dpm"].rn}`;
  const sid3 = `${list.sid}/${dpm3.body["m2m:dpm"].rn}`;

  // Step 1: dpm1 deployed -> running.
  const r1 = await update(srv.baseUrl, sid1, { "m2m:dpm": { mcmd: 1 } });
  assert.equal(r1.rsc, "2004", `Step 1: mcmd=1 on dpm1 failed: ${r1.raw.slice(0, 200)}`);
  assert.equal(r1.body["m2m:dpm"].mds, 1, "Step 1: dpm1 should be running (1) after mcmd=1");

  // Step 2: dpm2 deployed -> running.
  const r2 = await update(srv.baseUrl, sid2, { "m2m:dpm": { mcmd: 1 } });
  assert.equal(r2.rsc, "2004", `Step 2: mcmd=1 on dpm2 failed: ${r2.raw.slice(0, 200)}`);
  assert.equal(r2.body["m2m:dpm"].mds, 1, "Step 2: dpm2 should be running (1) after mcmd=1");

  // Step 3: dpm2 running -> stopped.
  const r3 = await update(srv.baseUrl, sid2, { "m2m:dpm": { mcmd: 0 } });
  assert.equal(r3.rsc, "2004", `Step 3: mcmd=0 on dpm2 failed: ${r3.raw.slice(0, 200)}`);
  assert.equal(r3.body["m2m:dpm"].mds, 2, "Step 3: dpm2 should be stopped (2) after mcmd=0");

  // Step 4: dpm3 is left alone, still at its default deployed status.
  const gotDpm3 = await retrieve(srv.baseUrl, sid3);
  assert.equal(gotDpm3.body["m2m:dpm"].mds, 0, "Step 4: dpm3 should remain deployed (0), untouched by dpm1/dpm2's transitions");

  // Step 5: the parent's three counters, one per state.
  const list1 = (await retrieve(srv.baseUrl, list.sid)).body["m2m:mdp"];
  assert.equal(list1.ndm, 1, "Step 5: numberOfDeployedModels should count dpm3 only");
  assert.equal(list1.nrm, 1, "Step 5: numberOfRunningModels should count dpm1 only");
  assert.equal(list1.nsm, 1, "Step 5: numberOfStoppedModels should count dpm2 only");

  // Post-condition: the three counters always sum to the number of child <modelDeployment>s (3),
  // regardless of how individual deployments' states are distributed across them.
  assert.equal(list1.ndm + list1.nrm + list1.nsm, 3,
    "post-condition: ndm+nrm+nsm should equal the deployment count (3), not drift after mixed run/stop transitions");
});

// -------------------------------------------------------------------------------------------
// SCN/E2E -- dataset -> model -> deployment, straight through
// -------------------------------------------------------------------------------------------

test("TC_TR0071_SCN_E2E_01: TP/TR-0071/CSE/SCN/E2E/001 — dataset to model to deployment, straight through", async () => {
  // TR-0068:7.8.1 Description gives three numbered items, not "Step"s: "1) prepare training
  // dataset with IoT sensor data / 2) build AI models with dataset preprocessing, training and
  // validation / 3) deploy the models to an IoT device and perform inferencing." The same clause
  // says item 1 "has been described in clause 7.7" and this clause (7.8) "describes how the third
  // step can be done" -- i.e. items 1 and 3 are exactly the flows TC_TR0071_SCN_DST_01 and
  // TC_TR0071_SCN_MDL_01's Steps 4-7 already cover, chained together here to confirm the handoff
  // between them does not silently drop a resource along the way.
  const sink = await startSink();
  try {
    // Item 1 (TR-0068:7.8.1): "prepare training dataset with IoT sensor data".
    const { dtsSid } = await runHistoricalDatasetFlow();

    // Item 2 (TR-0068:7.8.1): "build AI models with dataset preprocessing, training and
    // validation" -- TR-0068 itself calls this "done by data scientists or AI modelers with their
    // expertise", i.e. not an API call the CSE participates in. It is stood in for here by
    // registering an <mlModel> (TP/TR-0071/CSE/MDL/CRE/002, TP/TR-0071/CSE/MDL/CRE/004) --
    // TR-0071 defines no attribute linking a <mlModel> back to the <dataset> it trained on, so the
    // data connection between item 1 and item 2 is explicitly out of scope here, as
    // features/test-purposes/TR-0071.md's note under this TP already says.
    const repo = await makeRepo();
    assert.equal(repo.res.rsc, "2001", `Item 2 (TR-0068:7.8.1): <modelRepo> create failed: ${repo.res.raw.slice(0, 200)}`);
    const rawModel = "trained-regressor-bytes";
    const model = await makeModel(repo.sid, { mmd: rawModel });
    assert.equal(model.res.rsc, "2001", `Item 2 (TR-0068:7.8.1): <mlModel> registration failed: ${model.res.raw.slice(0, 200)}`);
    assert.equal(model.body.mms, Buffer.byteLength(rawModel, "utf8"),
      "Item 2 (TR-0068:7.8.1): mlModelSize should equal the byte length of the mlModel field as stored");

    // Item 3 (TR-0068:7.8.1): "deploy the models to an IoT device and perform inferencing" --
    // TR-0068:7.8.6's Steps 4-7 (the target-facing half of SCN/MDL/001), reused verbatim.
    const { depSid, originator } = await runDeployAndInferFlow(sink, model);

    // Post-condition: the dataset, the model and the deployment all still exist at once -- the
    // chain from item 1 through item 3 did not drop a resource anywhere along the way. (This
    // checks that the three resources coexist, not that they reference each other -- TR-0071
    // defines no attribute for that cross-reference, per the note on item 2 above.)
    const gotDts = await retrieve(srv.baseUrl, dtsSid);
    assert.equal(gotDts.rsc, "2000", "post-condition (TR-0068:7.8.1): the historical <dataset> from item 1 should still exist");
    const gotModel = await retrieve(srv.baseUrl, model.sid);
    assert.equal(gotModel.rsc, "2000", "post-condition (TR-0068:7.8.1): the <mlModel> from item 2 should still exist");
    const gotDep = await retrieve(srv.baseUrl, depSid, { originator });
    assert.equal(gotDep.rsc, "2000", "post-condition (TR-0068:7.8.1): the <modelDeployment> from item 3 should still exist");
  } finally {
    await sink.stop();
  }
});
