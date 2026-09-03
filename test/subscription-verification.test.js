"use strict";
// TS-0004:7.4.8.2.1 Recv-6.4 scopes verification to notificationURI entries that "are not the
// Originator and are formatted as oneM2M-compliant resource-IDs". TS-0001:9.6.8 defines that
// format as a structured or unstructured CSE-Relative-, SP-Relative-, or Absolute-Resource-ID
// "of an <AE> or <CSEBase> resource" -- as opposed to a protocol-binding URL. So the axis is
// resource-ID versus URL, and both halves have to be pinned: a URL that gets verified would
// break every existing deployment, and a resource-ID that does not would make the feature inert.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { is_resource_id_target, verification_targets } = require("../cse/subscription-verification");

test("a protocol-binding URL is not a verification target", () => {
  // coap:// is deliberately absent from this list. The standard names coap as a binding, but
  // mobius4 has none and cse/noti.js does not exclude it, so a coap:// entry is a resource-ID to
  // the code that actually sends notifications. Calling it a URL here would split the two rules.
  // See "the URL rule is the one cse/noti.js applies" below, which pins the whole correspondence.
  for (const url of ["http://host/notify", "https://host/notify", "mqtt://broker/x"]) {
    assert.equal(is_resource_id_target(url), false, url);
  }
});

test("a oneM2M resource-ID is a verification target", () => {
  for (const id of ["/CSE1/AE1", "CAE123", "//dom/CSE1/AE1", "Mobius/ae1"]) {
    assert.equal(is_resource_id_target(id), true, id);
  }
});

test("the Originator's own entry is excluded", () => {
  // The clause says "are not the Originator" -- a subscriber notifying itself has nothing to
  // verify, and asking it to would make the common self-subscription case fail.
  const got = verification_targets(["/CSE1/AE1", "/CSE1/AE2"], "/CSE1/AE1");
  assert.deepEqual(got, ["/CSE1/AE2"]);
});

test("URLs and the Originator are filtered together", () => {
  const got = verification_targets(["http://h/n", "/CSE1/AE1", "/CSE1/AE2"], "/CSE1/AE1");
  assert.deepEqual(got, ["/CSE1/AE2"]);
});

test("the response status codes are the values the standard assigns", () => {
  // Read from CDT-enumerationTypes.xsd, not from memory. A wrong RSC is silent: the request
  // fails either way and only a conformance tester notices the number.
  const enums = require("../config/enums");
  assert.equal(enums.rsc_str.SUBSCRIPTION_CREATOR_HAS_NO_PRIVILEGE, 4101);
  assert.equal(enums.rsc_str.SUBSCRIPTION_VERIFICATION_INITIATION_FAILED, 5204);
  assert.equal(enums.rsc_str.SUBSCRIPTION_HOST_HAS_NO_PRIVILEGE, 5205);
});

test("verification is off unless a deployment turns it on", () => {
  const { verification_enabled } = require("../cse/subscription-verification");
  assert.equal(verification_enabled(), false, "config/default.json must ship it disabled");
});

test("the Originator is excluded however it is spelled", () => {
  // Without this the whole normalisation could be deleted and every other test here would still
  // pass -- each of them writes the Originator and the nu entry as the same string, which plain
  // equality already handles. This is the case that needs it: one AE, the three spellings
  // TS-0001:7.2 defines for it, and a subscription that must not try to verify itself.
  //
  // The spellings are built from the configuration in force rather than written out, because they
  // are not the same on every deployment -- an earlier version of this test hardcoded an SP-ID
  // from one machine's config/local.json and failed anywhere else.
  const config = require("config");
  const { verification_targets } = require("../cse/subscription-verification");
  const cseRelative = `${config.cse.csebase_rn}/ae1`;
  const spellings = [
    cseRelative,
    `${config.cse.cse_id}/${cseRelative}`,
    `${config.cse.sp_id}${config.cse.cse_id}/${cseRelative}`,
  ];
  const other = `${config.cse.csebase_rn}/ae2`;
  for (const spelling of spellings) {
    assert.deepEqual(
      verification_targets([cseRelative, other], spelling), [other],
      `the Originator written as ${spelling} must still be recognised as ${cseRelative}`);
  }
});

test("the module loads without a deployment's own configuration", () => {
  // Not a style point. This module used to reach get_to_info in cse/reqPrim.js, which pulls in the
  // CSE's module graph, and cse/datasetManager.js reads config.get("cse.admin") at load time --
  // an identity config/default.json deliberately does not ship (v4.6.0 removed it so that an
  // operator who never sets one is stopped at startup). Requiring this module therefore threw
  // outright wherever config/local.json was absent: every test here passed on a developer machine
  // and every one of them failed in CI, on a require, before a single assertion ran.
  //
  // Checked in a child process against a configuration directory holding only the shipped
  // default.json, which is what CI actually has.
  const { spawnSync } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const repoRoot = path.resolve(__dirname, "..");
  const bareConfig = fs.mkdtempSync(path.join(os.tmpdir(), "mobius4-bare-config-"));
  fs.copyFileSync(path.join(repoRoot, "config", "default.json"), path.join(bareConfig, "default.json"));

  const r = spawnSync(process.execPath, ["-e",
    "const m = require('./cse/subscription-verification');" +
    "process.stdout.write(JSON.stringify(m.verification_targets(['/CSE1/AE1', '/CSE1/AE2'], '/CSE1/AE1')));"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, NODE_ENV: "test", NODE_CONFIG_DIR: bareConfig } });

  assert.equal(r.status, 0, `loading the module must not need a deployment identity: ${r.stderr}`);
  assert.equal(r.stdout, JSON.stringify(["/CSE1/AE2"]), "and it must still answer correctly");
});

test("the URL rule is the one cse/noti.js applies, coap included", () => {
  // noti.js sends to an nu entry by poa lookup unless it starts with http or mqtt. coap is not in
  // that list, so a coap:// entry is a resource-ID to noti.js. This module must agree -- treating
  // it as a URL here would mean an entry that gets notified but is never verified.
  const { is_resource_id_target } = require("../cse/subscription-verification");
  const noti_treats_as_url = (nu) => nu.startsWith("http") || nu.startsWith("mqtt");
  for (const nu of ["http://h/n", "https://h/n", "mqtt://b/t", "coap://h/n", "/CSE1/AE1", "CAE123", "Mobius/ae1"]) {
    assert.equal(is_resource_id_target(nu), !noti_treats_as_url(nu), nu);
  }
});

test("an ordinary notification is not treated as a verification request", async () => {
  // The receive path answers 2000 to every NOTIFY today. Whatever this adds must not change
  // that for a normal notification -- every existing subscription depends on it.
  const { handle_verification } = require("../cse/subscription-verification");
  const resp = {};
  const handled = await handle_verification(
    { op: 5, fr: "/CSE1/AE1", to: "Mobius/ae1", pc: { "m2m:sgn": { nev: { rep: {}, net: 3 } } } }, resp);
  assert.equal(handled, false);
  assert.deepEqual(resp, {}, "an untouched response must be left for the normal path");
});

test("a verification request with no creator is refused 4000", async () => {
  // TS-0004:7.5.1.2.3 has the sender set creator to "the Originator ID of the subscription
  // creation request". Without it the receiver has nobody to check, so the request is malformed
  // rather than unauthorised.
  const { handle_verification } = require("../cse/subscription-verification");
  const resp = {};
  const handled = await handle_verification(
    { op: 5, fr: "/CSE1", to: "Mobius/ae1", pc: { "m2m:sgn": { vrq: true } } }, resp);
  assert.equal(handled, true);
  assert.equal(resp.rsc, 4000);
});

test("a NOTIFY that is not a verification request still answers 2000", async () => {
  // The whole receive path, not the module -- what would break a deployment is the wiring,
  // not the predicate.
  const { startServer } = require("./helpers/server");
  const { startSink } = require("./helpers/noti-sink");
  const { ADMIN } = require("./helpers/onem2m");
  const srv = await startServer();
  try {
    const r = await fetch(`${srv.baseUrl}/Mobius`, {
      method: "POST",
      headers: {
        // The default <CSEBase> ACP does not grant NOTIFY (acop bit 16) to 'all' originators --
        // only create/retrieve/update/discovery (db/init.js create_default_acp). An arbitrary
        // unregistered origin gets 4103 here before this task's code is ever reached, which is
        // what "Cverif-probe" from the plan actually measured. Using ADMIN isolates the check
        // to the wiring this task adds.
        "X-M2M-Origin": ADMIN, "X-M2M-RI": "v1", "X-M2M-RVI": "4",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ "m2m:sgn": { nev: { rep: { "m2m:cin": { con: 1 } }, net: 3 }, sur: "x" } }),
    });
    assert.equal(r.headers.get("x-m2m-rsc"), "2000");
  } finally {
    await srv.stop();
  }
});

test("a verification request whose creator and Originator both hold NOTIFY is accepted", async () => {
  // TS-0004:7.5.1.2.3 receiver side: creator and Originator both need NOTIFY privilege to the
  // notificationURI, and then the response is a success. Every other test here reaches a refusal,
  // and a refusal is what a broken privilege check produces too -- so nothing above this line can
  // tell "checked and allowed" from "checked wrongly and denied".
  //
  // That mattered: the check passes a request to access_decision, which fetches the target through
  // retrieve_a_res, which dispatches on to_ty alone. Built without to_ty, the fetch matched no
  // case, left pc unset, and access_decision read that as "no such resource" -- so every
  // verification was refused 4101 however the privileges actually stood. Only the success path
  // shows it.
  //
  // TS-0018에 해당 TP 없음 -- CSE/SUB/NTF/001 and /002 both describe refusals.
  const { startServer } = require("./helpers/server");
  const { create, CSE_BASE, ADMIN, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer();
  try {
    const NOTIFY_BIT = 16;   // acop bit 5, TS-0001:9.6.2
    const RETRIEVE_BIT = 2;  // deliberately not NOTIFY -- the negative case below turns on this
    const allowed = "Cverif-allowed";
    const denied = "Cverif-denied";

    const acpRn = uniqueRn("acp");
    const madeAcp = await create(srv.baseUrl, CSE_BASE, 1, { "m2m:acp": {
      rn: acpRn,
      pv: { acr: [
        { acor: [allowed], acop: NOTIFY_BIT },
        { acor: [denied], acop: RETRIEVE_BIT },
        { acor: [ADMIN], acop: 63 },
      ]},
      pvs: { acr: [{ acor: [ADMIN], acop: 63 }] },
    }});
    assert.equal(madeAcp.rsc, "2001", `policy setup failed: ${madeAcp.raw.slice(0, 200)}`);

    // The notification target: a <container> carrying that policy, addressed by resource ID the
    // way a resource-ID notificationURI would be.
    const cntRn = uniqueRn("c");
    const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, {
      "m2m:cnt": { rn: cntRn, acpi: [`${CSE_BASE}/${acpRn}`] },
    });
    assert.equal(madeCnt.rsc, "2001", `target setup failed: ${madeCnt.raw.slice(0, 200)}`);

    const verify = async (creator, originator) => {
      const r = await fetch(`${srv.baseUrl}/${CSE_BASE}/${cntRn}`, {
        method: "POST",
        headers: {
          "X-M2M-Origin": originator, "X-M2M-RI": uniqueRn("v"), "X-M2M-RVI": "4",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ "m2m:sgn": { vrq: true, cr: creator } }),
      });
      return r.headers.get("x-m2m-rsc");
    };

    assert.equal(await verify(allowed, allowed), "2000",
      "both parties hold NOTIFY on the target, so the verification succeeds");
    assert.equal(await verify(denied, allowed), "4101",
      "the creator holds RETRIEVE but not NOTIFY");
    assert.equal(await verify(allowed, denied), "5205",
      "the creator is fine; the host sending the request is not -- TS-0004:7.5.1.2.3 names this " +
      "code for it, and it only wins because verification is judged before the generic access " +
      "check, which answered 4103 and left this branch unreachable");
  } finally {
    await srv.stop();
  }
});

// --- send side: verify_targets, wired into <subscription> creation (cse/resources/sub.js) ---

test("verification is skipped entirely when the setting is off", async () => {
  // The default. A URL-only deployment must be untouched, and so must a resource-ID one.
  const { verify_targets } = require("../cse/subscription-verification");
  assert.equal(await verify_targets(["/CSE1/AE1"], "/CSE1/AE9"), null);
});

// The four tests below exercise the whole path -- CREATE <subscription> over HTTP, through
// cse/resources/sub.js's call to verify_targets and cse/noti.js's send_verification -- rather
// than the module in isolation. A single test server plays both roles: the CSE under test, and
// (through a local <AE> whose poa points at a sink this file controls) the verification target.
// That is enough to choose what RSC the target answers, which is what these scenarios turn on;
// test/helpers/two-cse.js's two full registered CSEs are not needed for that.

// A local sink whose response X-M2M-RSC is fixed by the caller. test/helpers/noti-sink.js
// always answers 2000 -- it exists to prove notifications *arrive*, not to test the CSE's
// reaction to a target's refusal -- so it cannot exercise "the target refuses verification" on
// its own.
async function startRscSink(rsc) {
  const http = require("node:http");
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      received.push({ headers: req.headers, body: parsed });
      res.writeHead(200, { "X-M2M-RSC": String(rsc), "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/noti`,
    received,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Registers an <AE> with no From (a fresh AE-ID -- the shared ADMIN originator collides with
// 4117 on a second registration) and the given poa list (or none), and returns its resource IDs.
async function aeWithPoa(baseUrl, poa) {
  const { create, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const rn = uniqueRn("ae");
  const body = poa
    ? { "m2m:ae": { rn, api: "Nsv.verif", rr: true, poa } }
    : { "m2m:ae": { rn, api: "Nsv.verif", rr: false } };
  const res = await create(baseUrl, CSE_BASE, 2, body, { originator: "" });
  assert.equal(res.rsc, "2001", `failed to create the target <AE>: ${res.raw.slice(0, 200)}`);
  return { sid: `${CSE_BASE}/${rn}`, ri: res.body["m2m:ae"].ri };
}

test("regression: with the setting off, a resource-ID nu subscription is created untouched (2001)", async () => {
  // TS-0018에 해당 TP 없음 -- every CRE/NTF TP in this group assumes verification is active; this
  // pins the off default, which is what the plan's Global Constraint ("기존 시험 660건이 계속
  // 통과해야 한다... nu가 URL인 기존 구독 시험은 동작이 바뀌면 안 된다") extends to a resource-ID nu.
  const { startServer } = require("./helpers/server");
  const { create, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer(); // subscription_verification defaults to false
  try {
    // No poa: if the off-switch were wired wrong this would fail to verify and prove the point
    // more sharply than a reachable target would.
    const target = await aeWithPoa(srv.baseUrl, null);
    const cntRn = uniqueRn("c");
    const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntRn } });
    assert.equal(madeCnt.rsc, "2001", `failed to create the parent <container>: ${madeCnt.raw.slice(0, 200)}`);

    const subRn = uniqueRn("s");
    const madeSub = await create(srv.baseUrl, `${CSE_BASE}/${cntRn}`, 23, {
      "m2m:sub": { rn: subRn, nu: [target.sid], enc: { net: [3] }, nct: 1 },
    });
    assert.equal(madeSub.rsc, "2001",
      `subscription creation must not be blocked when the setting is off: ${madeSub.raw.slice(0, 200)}`);
  } finally {
    await srv.stop();
  }
});

test("on: the target answers OK, the subscription is created (2001)", async () => {
  // TS-0018에 해당 TP 없음 -- no CRE/NTF TP describes the plain success path separately from an
  // ordinary creation; this pins Recv-6.4 step 5(b)'s "OK" branch.
  const { startServer } = require("./helpers/server");
  const { startSink } = require("./helpers/noti-sink");
  const { create, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer({ cse: { subscription_verification: true } });
  const sink = await startSink();
  try {
    const target = await aeWithPoa(srv.baseUrl, [sink.url]);
    const cntRn = uniqueRn("c");
    const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntRn } });
    assert.equal(madeCnt.rsc, "2001", `failed to create the parent <container>: ${madeCnt.raw.slice(0, 200)}`);

    const subRn = uniqueRn("s");
    const madeSub = await create(srv.baseUrl, `${CSE_BASE}/${cntRn}`, 23, {
      "m2m:sub": { rn: subRn, nu: [target.sid], enc: { net: [3] }, nct: 1 },
    });
    assert.equal(madeSub.rsc, "2001",
      `verification succeeded but the creation was refused: ${madeSub.raw.slice(0, 200)}`);

    const verif = sink.received.find((i) => i.body?.["m2m:sgn"]?.vrq === true);
    assert.ok(verif, "the sink must have received a verification NOTIFY before the create answered");
    assert.equal(verif.body["m2m:sgn"].cr, "test-admin",
      "creator is the Originator of the subscription creation request (TS-0004:7.5.1.2.3)");
    assert.equal(verif.body["m2m:sgn"].sur, undefined,
      "sur must be absent -- the <subscription> did not exist yet when this was sent");
  } finally {
    await sink.stop();
    await srv.stop();
  }
});

test("TP/oneM2M/CSE/SUB/CRE/003 on: the target has no reachable pointOfAccess, the creation is " +
  "refused 5204 and no <subscription> is created (TC_ONEM2M_SUB_CRE_03)", async () => {
  const { startServer } = require("./helpers/server");
  const { create, discover, urils, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer({ cse: { subscription_verification: true } });
  try {
    const target = await aeWithPoa(srv.baseUrl, null); // rr:false, no poa -- "cannot be sent"
    const cntRn = uniqueRn("c");
    const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntRn } });
    assert.equal(madeCnt.rsc, "2001", `failed to create the parent <container>: ${madeCnt.raw.slice(0, 200)}`);
    const cntSid = `${CSE_BASE}/${cntRn}`;

    const subRn = uniqueRn("s");
    const madeSub = await create(srv.baseUrl, cntSid, 23, {
      "m2m:sub": { rn: subRn, nu: [target.sid], enc: { net: [3] }, nct: 1 },
    });
    assert.equal(madeSub.rsc, "5204",
      `expected SUBSCRIPTION_VERIFICATION_INITIATION_FAILED: ${madeSub.raw.slice(0, 200)}`);

    // RSC alone does not prove there was no partial creation. Retrieve the parent -- discover()
    // is a RETRIEVE of cntSid with the discovery filter usage -- and confirm the <subscription>
    // is not among its descendants.
    const found = await discover(srv.baseUrl, cntSid);
    assert.deepEqual(urils(found), [], "no <subscription> child may exist after a refused verification");
  } finally {
    await srv.stop();
  }
});

test("on: the target refuses the verification NOTIFY (4103), the creation is refused 5204", async () => {
  // TS-0018에 해당 TP 없음. TP/oneM2M/CSE/SUB/NTF/001 and /002 look adjacent -- a target's Notify
  // response carrying SUBSCRIPTION_CREATOR_HAS_NO_PRIVILEGE (4101) / SUBSCRIPTION_HOST_HAS_NO_
  // PRIVILEGE (5205) -- but both (TS-0018 v4.6.1, Release 1) have the Hosting CSE propagate that
  // *same* code back to the subscription creator. The current TS-0004:7.4.8.2.1 Recv-6.4 step
  // 5(b) (v5.2.0, read via spec.get_clause during this task) instead fixes the response to
  // SUBSCRIPTION_VERIFICATION_INITIATION_FAILED for *any* non-OK Notify response, regardless of
  // which code it carried. The two disagree, so neither TP is cited here -- the correspondence
  // is not certain, and this task's implementation follows the current clause.
  const { startServer } = require("./helpers/server");
  const { create, CSE_BASE, uniqueRn } = require("./helpers/onem2m");
  const srv = await startServer({ cse: { subscription_verification: true } });
  const rscSink = await startRscSink(4103);
  try {
    const target = await aeWithPoa(srv.baseUrl, [rscSink.url]);
    const cntRn = uniqueRn("c");
    const madeCnt = await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: cntRn } });
    assert.equal(madeCnt.rsc, "2001", `failed to create the parent <container>: ${madeCnt.raw.slice(0, 200)}`);

    const subRn = uniqueRn("s");
    const madeSub = await create(srv.baseUrl, `${CSE_BASE}/${cntRn}`, 23, {
      "m2m:sub": { rn: subRn, nu: [target.sid], enc: { net: [3] }, nct: 1 },
    });
    assert.equal(madeSub.rsc, "5204",
      `expected SUBSCRIPTION_VERIFICATION_INITIATION_FAILED: ${madeSub.raw.slice(0, 200)}`);
    assert.equal(rscSink.received.length, 1, "the verification NOTIFY must have reached the target");
  } finally {
    await rscSink.stop();
    await srv.stop();
  }
});
