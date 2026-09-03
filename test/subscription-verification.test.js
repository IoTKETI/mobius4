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
  // Without this the whole get_to_info normalisation could be deleted and every other test here
  // would still pass -- each of them writes the Originator and the nu entry as the same string,
  // which plain equality already handles. This is the case that needs it: one AE, three legal
  // spellings of its resource ID, and a subscription that must not try to verify itself.
  //
  // The values are the ones get_to_info actually collapses on this deployment's identity
  // (cse_id /Mobius4, csebase Mobius), measured rather than assumed.
  const { verification_targets } = require("../cse/subscription-verification");
  for (const spelling of ["Mobius/ae1", "/Mobius4/Mobius/ae1", "//mydomain.io/Mobius4/Mobius/ae1"]) {
    assert.deepEqual(
      verification_targets(["Mobius/ae1", "Mobius/ae2"], spelling),
      ["Mobius/ae2"],
      `the Originator written as ${spelling} must still be recognised as Mobius/ae1`);
  }
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
    // Measured, not chosen: 4103, not the 5205 the clause names. The generic access control in
    // the request pipeline judges the NOTIFY on the Originator before handle_verification is
    // reached, and answers ORIGINATOR_HAS_NO_PRIVILEGE first. So the SUBSCRIPTION_HOST_HAS_NO_
    // PRIVILEGE branch is unreachable on the HTTP path today. It is kept because
    // TS-0004:7.5.1.2.3 asks for it and because it is what runs if that ordering ever changes,
    // but this assertion records what a caller actually sees rather than what the branch would
    // say. Whether to reorder so the clause's own code wins is an open decision (BACKLOG-132).
    assert.equal(await verify(allowed, denied), "4103",
      "the generic access check answers before the verification handler is reached");
  } finally {
    await srv.stop();
  }
});
