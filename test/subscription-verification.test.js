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
