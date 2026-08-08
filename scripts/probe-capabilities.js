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

const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(REPO_ROOT, "features", "capabilities.json");
const PROBE_DB = "mobius4_capabilities_probe";

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
];

// A <flexContainer> needs a registered specialization; an unregistered cnd is refused 4125.
// The envelope key is the prefix that specialization declares, not m2m:.
const FLX_CND = "http://developers.iotocean.org/schema/parkingBlock.xsd";
const FLX_KEY = "sc:parkingBlock";

// A success-class status (2xxx) is the only thing counted as support. Anything else — including
// a perfectly reasonable 4005 OPERATION_NOT_ALLOWED — is recorded with the status that came
// back, so that "refused on purpose" and "not implemented" stay distinguishable by whoever
// reads the file.
function support(res) {
  const rsc = Number(res.rsc);
  if (!Number.isFinite(rsc)) return { supported: false, rsc: null, note: "no X-M2M-RSC header" };
  return { supported: rsc >= 2000 && rsc < 3000, rsc };
}

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
      probed_at: new Date().toISOString().slice(0, 10),
      probed_against: gitDescribe(),
      entries: await probeResourceTypes(srv.baseUrl),
      procedures: await probeProcedures(srv.baseUrl),
    };
  } finally {
    await srv.stop();
    await dropDatabase();
  }

  // probed_at and the commit change on every run; comparing them would make --check fail
  // always and mean nothing. What must not drift is the observed behaviour.
  const observed = JSON.stringify({ entries: result.entries, procedures: result.procedures });
  const text = `${JSON.stringify(result, null, 2)}\n`;

  if (check) {
    if (!existsSync(OUT_PATH)) {
      console.error(`${OUT_PATH} does not exist — run: npm run probe-capabilities`);
      return 1;
    }
    const previous = JSON.parse(readFileSync(OUT_PATH, "utf-8"));
    if (JSON.stringify({ entries: previous.entries, procedures: previous.procedures }) === observed) {
      console.log(`capabilities: no drift (${result.entries.length} resource types, ${result.procedures.length} procedures)`);
      return 0;
    }
    console.error(
      "capabilities: what this CSE does no longer matches features/capabilities.json.\n" +
        "Run `npm run probe-capabilities` and commit the result."
    );
    return 1;
  }

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, text, "utf-8");
  const supported = result.entries.reduce(
    (n, e) => n + Object.values(e.operations).filter((o) => o.supported).length, 0);
  const procs = result.procedures.filter((p) => p.supported === true).length;
  const unprobed = result.procedures.filter((p) => p.supported === null).length;
  console.log(
    `capabilities: ${OUT_PATH}\n` +
      `  ${result.entries.length} resource types, ${supported} supported operations\n` +
      `  ${result.procedures.length} procedures — ${procs} supported, ${unprobed} not probed here`
  );
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
