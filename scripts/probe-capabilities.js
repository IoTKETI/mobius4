#!/usr/bin/env node
"use strict";
// What this CSE can actually do, established by asking it.
//
//   npm run probe-capabilities            # writes features/capabilities.json
//   npm run probe-capabilities -- --check # fails if the file is out of date, writes nothing
//
// Why a probe and not a document
// ------------------------------
// "Which parts of oneM2M does Mobius4 support?" is answered in three places, and only one of
// them cannot drift: README prose is written by hand, the feature inventory in the development
// repository records human judgement, and this file records **observed responses**. A claim
// here exists only because a request was sent and a Response Status Code came back.
//
// That is also its limit. It says nothing about *correctness* — a 2001 means the CSE created
// something, not that it created the right thing. Conformance lives in test/, which is written
// against the test purposes in oneM2M TS-0018. Read this as "the door opens", not "the room is
// furnished".
//
// It runs against an isolated instance on its own database and a free port (test/helpers/
// server.js), so it never touches a development or production deployment.

const { writeFileSync, readFileSync, existsSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Client } = require("pg");
const config = require("config");

const { startServer } = require("../test/helpers/server");
const { startSink } = require("../test/helpers/noti-sink");
const { request, discover, urils, CSE_BASE, ADMIN } = require("../test/helpers/onem2m");
const { support, hasDrifted, summarize } = require("./lib/capabilities");

const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(REPO_ROOT, "features", "capabilities.json");
const PROBE_DB = "mobius4_capabilities_probe";

/** Bump when a consumer that assumes the current shape would read the new one wrongly. */
const CAPABILITIES_FORMAT_VERSION = 1;

// ── the resource types to ask about ───────────────────────────────────────────────────────────
//
// long_name is copied from the resourceType enumeration in oneM2M TS-0004, not invented: the
// short name is what travels on the wire and the long name is what the specification calls it.
const RESOURCE_TYPES = [
  { ty: 1, short_name: "acp", long_name: "accessControlPolicy" },
  { ty: 2, short_name: "ae", long_name: "AE" },
  { ty: 3, short_name: "cnt", long_name: "container" },
  { ty: 4, short_name: "cin", long_name: "contentInstance" },
  { ty: 5, short_name: "cb", long_name: "CSEBase" },
  { ty: 9, short_name: "grp", long_name: "group" },
  { ty: 16, short_name: "csr", long_name: "remoteCSE" },
  { ty: 23, short_name: "sub", long_name: "subscription" },
  { ty: 28, short_name: "flx", long_name: "flexContainer" },
  { ty: 29, short_name: "ts", long_name: "timeSeries" },
  { ty: 30, short_name: "tsi", long_name: "timeSeriesInstance" },

  // TR-0071 (Technical Report) candidate solution types. Not in the resourceType enumeration of
  // TS-0004 — these numbers are Mobius4's own allocation (config/enums.js) and may change if
  // oneM2M standardises them. long_name comes from TR-0071 clauses 7.1.2 and 7.2.2.
  { ty: 101, short_name: "mrp", long_name: "modelRepo", source: "TR-0071" },
  { ty: 102, short_name: "mmd", long_name: "mlModel", source: "TR-0071" },
  { ty: 103, short_name: "mdp", long_name: "modelDeploymentList", source: "TR-0071" },
  { ty: 104, short_name: "dpm", long_name: "modelDeployment", source: "TR-0071" },
  { ty: 105, short_name: "dsp", long_name: "mlDatasetPolicy", source: "TR-0071" },
  { ty: 106, short_name: "dts", long_name: "dataset", source: "TR-0071" },
  { ty: 107, short_name: "dsf", long_name: "datasetFragment", source: "TR-0071" },
];

// A <flexContainer> needs a registered specialization; an unregistered cnd is refused 4125.
// The envelope key is the prefix that specialization declares, not m2m:.
const FLX_CND = "http://developers.iotocean.org/schema/parkingBlock.xsd";
const FLX_KEY = "sc:parkingBlock";

async function withPostgres(fn) {
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

// The database is dropped and recreated rather than swept. A probe that starts from leftovers
// gets a name collision on its fixtures and records 4105 CONFLICT as "not supported" — which is
// the one failure this file must never have, because it looks exactly like a real answer.
async function recreateDatabase() {
  await withPostgres(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`);
    await c.query(`CREATE DATABASE ${PROBE_DB}`);
  });
}

async function dropDatabase() {
  await withPostgres((c) => c.query(`DROP DATABASE IF EXISTS ${PROBE_DB}`));
}

function gitDescribe() {
  const run = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  try {
    return { commit: run(["rev-parse", "--short", "HEAD"]), version: require("../package.json").version };
  } catch {
    return { commit: "unknown", version: require("../package.json").version };
  }
}

// ── resource types ────────────────────────────────────────────────────────────────────────────
//
// The fixtures form one tree, so a CREATE that fails takes its children out of scope. Those
// operations are then left *absent* from the output rather than recorded as unsupported: not
// having asked and having been told no are different facts.
async function probeResourceTypes(base) {
  const ops = new Map(RESOURCE_TYPES.map((rt) => [rt.ty, {}]));
  const set = (ty, op, res) => { ops.get(ty)[op] = support(res); };

  const post = (to, ty, body) => request(base, { method: "POST", to, ty, body });
  const get = (to) => request(base, { method: "GET", to });
  const put = (to, body) => request(base, { method: "PUT", to, body });
  const del = (to) => request(base, { method: "DELETE", to });
  const created = (res) => res.rsc === "2001";

  // <CSEBase> is not created or deleted over Mca; only RETRIEVE and UPDATE are meaningful to
  // ask about, and UPDATE is expected to refuse. Both answers are recorded as observed.
  set(5, "retrieve", await get(CSE_BASE));
  set(5, "update", await put(CSE_BASE, { "m2m:cb": { lbl: ["probe"] } }));

  const acp = await post(CSE_BASE, 1, {
    "m2m:acp": {
      rn: "probe_acp",
      pv: { acr: [{ acor: [ADMIN], acop: 63 }] },
      pvs: { acr: [{ acor: [ADMIN], acop: 63 }] },
    },
  });
  set(1, "create", acp);
  const acpSid = `${CSE_BASE}/probe_acp`;
  if (created(acp)) {
    set(1, "retrieve", await get(acpSid));
    set(1, "update", await put(acpSid, { "m2m:acp": { lbl: ["probe"] } }));
  }

  const ae = await post(CSE_BASE, 2, { "m2m:ae": { rn: "probe_ae", api: "Nprobe", rr: false, srv: ["3"] } });
  set(2, "create", ae);
  const aeSid = `${CSE_BASE}/probe_ae`;
  if (created(ae)) {
    set(2, "retrieve", await get(aeSid));
    set(2, "update", await put(aeSid, { "m2m:ae": { lbl: ["probe"] } }));
  }

  // <remoteCSE> stands for another CSE that has registered here. Creating one directly is what
  // a registering CSE does, so a single instance can answer for all four operations.
  const csr = await post(CSE_BASE, 16, {
    "m2m:csr": { rn: "probe_csr", cb: "/probe-cse/Mobius", csi: "/probe-cse", rr: true, srv: ["4", "3"] },
  });
  set(16, "create", csr);
  const csrSid = `${CSE_BASE}/probe_csr`;
  if (created(csr)) {
    set(16, "retrieve", await get(csrSid));
    set(16, "update", await put(csrSid, { "m2m:csr": { lbl: ["probe"] } }));
    set(16, "delete", await del(csrSid));
  }

  let cntSid = null;
  if (created(ae)) {
    const cnt = await post(aeSid, 3, { "m2m:cnt": { rn: "probe_cnt" } });
    set(3, "create", cnt);
    cntSid = `${aeSid}/probe_cnt`;
    if (created(cnt)) {
      set(3, "retrieve", await get(cntSid));
      set(3, "update", await put(cntSid, { "m2m:cnt": { lbl: ["probe"] } }));

      const cin = await post(cntSid, 4, { "m2m:cin": { rn: "probe_cin", cnf: "text/plain:0", con: "x" } });
      set(4, "create", cin);
      const cinSid = `${cntSid}/probe_cin`;
      if (created(cin)) {
        set(4, "retrieve", await get(cinSid));
        // No update: <contentInstance> is immutable by specification, so asking would record a
        // refusal that says nothing about this implementation.
        set(4, "delete", await del(cinSid));
      }

      const grp = await post(aeSid, 9, {
        "m2m:grp": { rn: "probe_grp", mt: 3, mnm: 10, csy: 1, mid: [cntSid] },
      });
      set(9, "create", grp);
      const grpSid = `${aeSid}/probe_grp`;
      if (created(grp)) {
        set(9, "retrieve", await get(grpSid));
        set(9, "update", await put(grpSid, { "m2m:grp": { lbl: ["probe"] } }));
        set(9, "delete", await del(grpSid));
      }

      const flx = await post(aeSid, 28, {
        [FLX_KEY]: { rn: "probe_flx", cnd: FLX_CND, type: "probe", name: "probe" },
      });
      set(28, "create", flx);
      const flxSid = `${aeSid}/probe_flx`;
      if (created(flx)) {
        set(28, "retrieve", await get(flxSid));
        set(28, "update", await put(flxSid, { [FLX_KEY]: { lbl: ["probe"] } }));
        set(28, "delete", await del(flxSid));
      }

      const ts = await post(aeSid, 29, { "m2m:ts": { rn: "probe_ts" } });
      set(29, "create", ts);
      const tsSid = `${aeSid}/probe_ts`;
      if (created(ts)) {
        set(29, "retrieve", await get(tsSid));
        set(29, "update", await put(tsSid, { "m2m:ts": { lbl: ["probe"] } }));

        const tsi = await post(tsSid, 30, {
          "m2m:tsi": { rn: "probe_tsi", dgt: "20260101T000000", con: "x" },
        });
        set(30, "create", tsi);
        const tsiSid = `${tsSid}/probe_tsi`;
        if (created(tsi)) {
          set(30, "retrieve", await get(tsiSid));
          // No update: TS-0001:10.2.4.27 — "The Update operation shall not apply to
          // <timeSeriesInstance> resource."
          set(30, "delete", await del(tsiSid));
        }
        set(29, "delete", await del(tsSid));
      }
    }

    // ── TR-0071 AI/ML types ─────────────────────────────────────────────────────────────────
    //
    // Placed here, not after this if(created(ae)) block, because <modelDeploymentList> needs a
    // live aeSid and <mlDatasetPolicy> needs a live cntSid — both are deleted a few lines below.
    // Order follows the tree: repository -> model, deployment list -> deployment,
    // policy -> (CSE-made) dataset.
    //
    // The dataset side is deliberately probed through the policy: TR-0071 clause 7.2.3.2 says
    // <dataset> is created by the hosting CSE, not by a client request, so asking for a direct
    // CREATE would record a fact about an operation the specification does not define. Clause
    // 7.2.3.3 says the same for <datasetFragment>, and adds that it is immutable — "the Create
    // procedure is not specified as an API [...] this resource is immutable so Update procedure
    // is not specified. No change from the Retrieve and Delete procedures in clause 10.1." So
    // <datasetFragment> is asked about below, but only for retrieve/delete — asking about
    // create/update would record a fact about operations the specification does not define,
    // same principle as <dataset> just above.
    //
    // cse/hostingCSE.js also has a client-facing CREATE case for ty 106/107 ("not called by
    // client, temporary for testing"). That is an implementation artifact, not a specified
    // operation, so it is not probed — probing it would put an unspecified capability in a file
    // whose whole point is to describe what the specification-facing surface does.
    const mrp = await post(CSE_BASE, 101, { "m2m:mrp": { rn: "probe_mrp" } });
    set(101, "create", mrp);
    const mrpSid = `${CSE_BASE}/probe_mrp`;
    // Captured for <modelDeployment>'s moid below, before this <mlModel> is deleted.
    let mmdRi = null;
    if (created(mrp)) {
      set(101, "retrieve", await get(mrpSid));
      set(101, "update", await put(mrpSid, { "m2m:mrp": { lbl: ["probe"] } }));

      const mmd = await post(mrpSid, 102, {
        "m2m:mmd": {
          rn: "probe_mmd", vr: "1.0.0", plf: "tensorFlow", mlt: "regression",
          mmu: "https://example.invalid/m.tflite",
        },
      });
      set(102, "create", mmd);
      const mmdSid = `${mrpSid}/probe_mmd`;
      if (created(mmd)) {
        set(102, "retrieve", await get(mmdSid));
        set(102, "update", await put(mmdSid, { "m2m:mmd": { lbl: ["probe"] } }));
        mmdRi = mmd.body?.["m2m:mmd"]?.ri ?? null;
        set(102, "delete", await del(mmdSid));
      }
      set(101, "delete", await del(mrpSid));
    }

    if (created(ae)) {
      const mdp = await post(aeSid, 103, { "m2m:mdp": { rn: "probe_mdp" } });
      set(103, "create", mdp);
      const mdpSid = `${aeSid}/probe_mdp`;
      if (created(mdp)) {
        set(103, "retrieve", await get(mdpSid));
        set(103, "update", await put(mdpSid, { "m2m:mdp": { lbl: ["probe"] } }));

        // moid (modelID, TR-0071 table 7.1.2.4-2) wants the resource ID of the <mlModel>, not
        // its name — the brief this was drafted from used the rn "probe_mmd" instead. TR-0071
        // marks it 1(L) (a list), but models/dpm-model.js stores it as a plain STRING(255), not
        // an array column, so a single value is what this implementation actually accepts.
        // inputResource/outputResource (inr/our) want "the resource ID of" a resource-sharing
        // resource; a structured ID resolves the same as a resource ID everywhere else this
        // codebase addresses a resource (cse/hostingCSE.js get_unstructuredID), so cntSid is
        // used the same way <group>'s mid is probed above.
        const dpm = await post(mdpSid, 104, {
          "m2m:dpm": { rn: "probe_dpm", moid: mmdRi || undefined, inr: cntSid, our: cntSid },
        });
        set(104, "create", dpm);
        const dpmSid = `${mdpSid}/probe_dpm`;
        if (created(dpm)) {
          set(104, "retrieve", await get(dpmSid));
          // modelCommand (mcmd) is an integer here (0: stop, 1: run) — cse/resources/dpm.js
          // update_a_dpm — not the "run"/"stop" strings TR-0071 defines. Sending the strings
          // would not be observing this implementation's real accepted shape.
          set(104, "update", await put(dpmSid, { "m2m:dpm": { mcmd: 1 } }));
          set(104, "delete", await del(dpmSid));
        }
        set(103, "delete", await del(mdpSid));
      }
    }

    if (cntSid) {
      // get_dataset_info (cse/datasetManager.js) resolves datasetStartTime/datasetEndTime from
      // the source container's oldest/latest <contentInstance>; without one it returns null and
      // create_a_dsp throws before answering. The <contentInstance> probed above under this same
      // container was already deleted, so fixtures are created here — this is not itself a
      // probe question, ty 4 already has one above.
      //
      // Two instances, not one: create_historical_dataset_fragments (cse/datasetManager.js)
      // only walks its `while (current_tcst < det)` loop when dst < det. dst/det come from the
      // source container's oldest/latest <contentInstance> `ct` (get_dataset_info); with a
      // single instance dst === det and the loop body — the only place a <datasetFragment> gets
      // created — never runs, so a probe with one fixture can never reach ty 107 at all. `ct`
      // has second, not millisecond, precision (config/default.json "timestamp_format"), so the
      // two creates need a real wait apart, not just two sequential calls — the same 1.1s wait
      // test/ai-dataset-management.test.js's makeSource() uses for the same reason.
      await post(cntSid, 4, { "m2m:cin": { rn: "probe_cin_ds_1", cnf: "text/plain:0", con: "x" } });
      await new Promise((r) => setTimeout(r, 1100));
      await post(cntSid, 4, { "m2m:cin": { rn: "probe_cin_ds_2", cnf: "text/plain:0", con: "y" } });

      // nrhd (numberOfRowsForHistoricalDataset) large enough that both rows land in one
      // fragment — test/ai-dataset-management.test.js's makeDatasetWithFragment() uses the same
      // value for the same reason: a single, predictable <datasetFragment> to probe, rather than
      // however many create_dataset_fragments (cse/datasetManager.js) would slice a small nrhd
      // into.
      const dsp = await post(CSE_BASE, 105, {
        "m2m:dsp": { rn: "probe_dsp", sri: [cntSid], dsfm: 1, nrhd: 100 },
      });
      set(105, "create", dsp);
      const dspSid = `${CSE_BASE}/probe_dsp`;
      if (created(dsp)) {
        set(105, "retrieve", await get(dspSid));
        set(105, "update", await put(dspSid, { "m2m:dsp": { lbl: ["probe"] } }));

        // <dataset>/<datasetFragment> are created by the CSE. Follow the link the policy hands
        // back rather than guessing a path.
        const dspBody = (await get(dspSid)).body?.["m2m:dsp"] ?? {};
        const dtsSid = dspBody.hdi || dspBody.ldi;
        if (dtsSid) {
          set(106, "retrieve", await get(dtsSid));

          // <datasetFragment> (ty 107) has no client-facing CREATE to learn its CSE-generated
          // `rn` from, so discovery is how a client would actually find one — the same approach
          // test/ai-dataset-management.test.js's makeDatasetWithFragment() uses. <dataset>'s
          // /la virtual resource (cse/resources/dts.js retrieve_la) would also resolve one, but
          // discovery is the generic procedure clause 7.2.3.3 points at ("No change from the
          // Retrieve [...] procedures in clause 10.1"), so it is used here instead of the
          // <container>-style virtual-resource shortcut.
          const frags = await discover(base, dtsSid, { ty: "107" });
          const dsfSid = urils(frags)[0];
          if (dsfSid) {
            set(107, "retrieve", await get(dsfSid));
            set(107, "delete", await del(dsfSid));
          }

          set(106, "delete", await del(dtsSid));
        }
        set(105, "delete", await del(dspSid));
      }
    }

    const sub = await post(aeSid, 23, {
      "m2m:sub": { rn: "probe_sub", nu: ["http://127.0.0.1:1/none"], enc: { net: [1] } },
    });
    set(23, "create", sub);
    const subSid = `${aeSid}/probe_sub`;
    if (created(sub)) {
      set(23, "retrieve", await get(subSid));
      set(23, "update", await put(subSid, { "m2m:sub": { lbl: ["probe"] } }));
      set(23, "delete", await del(subSid));
    }

    if (cntSid) set(3, "delete", await del(cntSid));
    set(2, "delete", await del(aeSid));
  }
  if (created(acp)) set(1, "delete", await del(acpSid));

  return RESOURCE_TYPES.map((rt) => ({ ...rt, operations: ops.get(rt.ty) }));
}

// ── procedures ────────────────────────────────────────────────────────────────────────────────
//
// Everything that is not "can I CRUD this resource type". These are what an application
// actually builds on, and they are exactly what the two-path OpenAPI document cannot express:
// every one of them is the same URL shape with different parameters.
//
// Scope: what one CSE can be asked on its own. Registration with another CSE, request
// forwarding and fanout to remote members need a second CSE and are covered by test/ instead —
// recorded here as an explicit gap rather than left to look unsupported.
async function probeProcedures(base) {
  const out = [];
  const record = (id, name, res, evidence) => {
    const s = support(res);
    out.push({ id, name, ...s, evidence });
    return s.supported;
  };

  const root = `${CSE_BASE}/probe_proc`;
  await request(base, { method: "POST", to: CSE_BASE, ty: 3, body: { "m2m:cnt": { rn: "probe_proc" } } });
  for (const rn of ["a", "b"]) {
    await request(base, { method: "POST", to: root, ty: 3, body: { "m2m:cnt": { rn, lbl: ["probe:x"] } } });
    await request(base, {
      method: "POST", to: `${root}/${rn}`, ty: 4,
      body: { "m2m:cin": { cnf: "text/plain:0", con: "hello" } },
    });
  }

  record("discovery.filter-usage", "Resource discovery (fu=1)",
    await discover(base, root, {}), "GET <target>?fu=1");
  record("discovery.resource-type", "Discovery filtered by resourceType (ty)",
    await discover(base, root, { ty: "3" }), "GET <target>?fu=1&ty=3");
  record("discovery.labels", "Discovery filtered by labels (lbl)",
    await discover(base, root, { lbl: "probe:x" }), "GET <target>?fu=1&lbl=probe:x");
  record("discovery.limit-offset", "Discovery paging (lim, ofst)",
    await discover(base, root, { lim: "1", ofst: "1" }), "GET <target>?fu=1&lim=1&ofst=1");
  record("discovery.level", "Discovery depth limit (lvl)",
    await discover(base, root, { lvl: "1" }), "GET <target>?fu=1&lvl=1");

  for (const rcn of [1, 4, 5, 6, 8]) {
    record(`result-content.rcn-${rcn}`, `Result Content rcn=${rcn} on RETRIEVE`,
      await request(base, { method: "GET", to: `${root}?rcn=${rcn}` }), `GET <target>?rcn=${rcn}`);
  }

  record("virtual.latest", "<latest> virtual resource",
    await request(base, { method: "GET", to: `${root}/a/la` }), "GET <container>/la");
  record("virtual.oldest", "<oldest> virtual resource",
    await request(base, { method: "GET", to: `${root}/a/ol` }), "GET <container>/ol");

  // fanOutPoint: a <group> cannot be a child of <container>, so it goes under the <CSEBase>.
  const grpRn = "probe_proc_grp";
  const grpSid = `${CSE_BASE}/${grpRn}`;
  await request(base, {
    method: "POST", to: CSE_BASE, ty: 9,
    body: { "m2m:grp": { rn: grpRn, mt: 3, mnm: 10, csy: 1, mid: [`${root}/a`, `${root}/b`] } },
  });
  record("group.fanout", "Request fan-out through <group>/fopt",
    await request(base, { method: "GET", to: `${grpSid}/fopt` }), "GET <group>/fopt");
  record("group.fanout-relative", "Fan-out with a path appended to fopt",
    await request(base, { method: "GET", to: `${grpSid}/fopt/la` }), "GET <group>/fopt/la");

  // Notification needs somewhere for the CSE to deliver to.
  const sink = await startSink();
  try {
    const subRn = "probe_proc_sub";
    const subCreate = await request(base, {
      method: "POST", to: `${root}/a`, ty: 23,
      body: { "m2m:sub": { rn: subRn, nu: [sink.url], enc: { net: [3] } } },
    });
    if (subCreate.rsc === "2001") {
      await request(base, {
        method: "POST", to: `${root}/a`, ty: 4,
        body: { "m2m:cin": { cnf: "text/plain:0", con: "notify" } },
      });
      // waitFor's predicate is handed each received notification, not the array of them —
      // passing `(items) => items.length > 0` matched nothing and recorded a working feature
      // as unsupported, which is precisely the mistake this file must not make.
      const arrived = await sink
        .waitFor(() => true, { timeoutMs: 5000 })
        .then(() => true)
        .catch(() => false);
      out.push({
        id: "notification.net-3", name: "Notification on child creation (net=3)",
        supported: arrived, rsc: arrived ? 2000 : null,
        evidence: "POST <subscription> with nu, then create a child and wait for delivery",
      });
    }
  } finally {
    await sink.stop();
  }

  await request(base, { method: "DELETE", to: grpSid });
  await request(base, { method: "DELETE", to: root });

  // Stated, not silently missing: a reader must be able to tell "we asked and it failed" from
  // "we could not ask here".
  for (const [id, name] of [
    ["registration.cse-to-cse", "Registration with another CSE (<remoteCSE> exchange)"],
    ["forwarding.sp-relative", "Request forwarding to a registered CSE"],
    ["group.remote-members", "Fan-out to group members hosted on another CSE"],
  ]) {
    out.push({
      id, name, supported: null, rsc: null,
      evidence: "not probed — needs a second CSE; covered by test/cse-registration-remote.test.js and test/group-remote-members.test.js",
    });
  }

  return out;
}

async function main() {
  const check = process.argv.includes("--check");

  await recreateDatabase();
  const srv = await startServer({ dbName: PROBE_DB });
  let result;
  try {
    result = {
      // The shape of this file, for the tools in the development repository that read it
      // across a repo boundary. They can be updated in the same change as the producer only
      // as long as both live here — and they do not. A consumer that meets a shape it does not
      // know has to be able to say so instead of misreading it: fields it expects may have
      // moved or changed meaning, and every one of those misreadings looks like a real answer.
      //
      // 1 — entries[] of resource types with per-operation support, procedures[] with
      //     supported true/false/null.
      formatVersion: CAPABILITIES_FORMAT_VERSION,
      probed_at: new Date().toISOString().slice(0, 10),
      probed_against: gitDescribe(),
      entries: await probeResourceTypes(srv.baseUrl),
      procedures: await probeProcedures(srv.baseUrl),
    };
  } finally {
    await srv.stop();
    await dropDatabase();
  }

  const summary = summarize(result);

  if (check) {
    if (!existsSync(OUT_PATH)) {
      console.error(`${OUT_PATH} does not exist — run: npm run probe-capabilities`);
      return 1;
    }
    const previous = JSON.parse(readFileSync(OUT_PATH, "utf-8"));
    if (!hasDrifted(previous, result)) {
      console.log(
        `capabilities: no drift (${summary.resourceTypes} resource types, ${summary.procedures} procedures)`
      );
      return 0;
    }
    console.error(
      "capabilities: what this CSE does no longer matches features/capabilities.json.\n" +
        "Run `npm run probe-capabilities` and commit the result."
    );
    return 1;
  }

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  console.log(
    `capabilities: ${OUT_PATH}\n` +
      `  ${summary.resourceTypes} resource types, ${summary.supportedOperations} supported operations\n` +
      `  ${summary.procedures} procedures — ${summary.supportedProcedures} supported, ` +
      `${summary.unprobedProcedures} not probed here`
  );
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
