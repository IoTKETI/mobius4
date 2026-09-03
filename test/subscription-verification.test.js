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
  for (const url of ["http://host/notify", "https://host/notify", "mqtt://broker/x", "coap://host/n"]) {
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
