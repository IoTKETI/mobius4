"use strict";
// Resource types whose access decision is made from the parent's policy.
//
// TS-0001:9.6.1.3.2 splits on whether a resource *type* has an accessControlPolicyIDs attribute at
// all -- not on whether a given resource left its own empty. A type that has none defers to the
// parent; a type that has one but leaves it unset falls to the default access policy instead (the
// custodian, or failing that the creator alone). The two are different answers, and picking the
// wrong one is wrong in both directions: too open under a permissive parent, and locking the
// creator out under a strict one.
//
// Members, and the wording that puts them here:
//   cin  <contentInstance>       TS-0001:9.6.7  "does not have its own accessControlPolicyIDs attribute"
//   tsi  <timeSeriesInstance>    TS-0001:9.6.37 same wording
//
// <schedule> was a member until v4.17.1 and is not one: TS-0001:9.6.9 gives it an
// accessControlPolicyIDs of its own, 0..1 RW. Removing it changed nothing observable, because
// mobius4 does not implement <schedule> -- which is also why no behaviour test could have caught
// it going in, and why test/unimplemented-and-clearing.test.js asserts this list's membership
// directly. BACKLOG-043.
//
// This lives in its own file rather than in cse/hostingCSE.js so that the test can read it without
// loading the CSE: requiring hostingCSE pulls in configuration that only exists inside a running
// server process, and a test that did so passed locally and failed in CI with
// 'Configuration property "cse.admin" is not defined'.

const NORM_RES_WITHOUT_ACPI = ["cin", "tsi"];

module.exports = { NORM_RES_WITHOUT_ACPI };
