"use strict";
// cse/resource-types.js's SUPPORTED_STANDARD_TYPES -- the <CSEBase>'s srt (TS-0001:9.6.3) is now
// derived from this constant rather than from configuration (DEC-137, mobius4-dev-tool). TS-0018
// has no test purpose for this: there is no TP/oneM2M/CSE/REG/* identifier for "the resource
// types a constant names match what this CSE actually implements" -- that is a cross-check
// against this repo's own artifacts, not a request/response the test system can send. Two things
// pin it down instead:
//
//   1. SUPPORTED_STANDARD_TYPES must equal the set of oneM2M-standard (ty < 100) resource types
//      features/capabilities.json's probe actually found working -- a supported type there is
//      one with any supported operation (e.g. <CSEBase>, ty 5, is retrieve-only and still
//      counts). If the two drift, srt either over- or under-advertises.
//   2. SUPPORTED_STANDARD_TYPES and UNIMPLEMENTED_TYPES must be disjoint -- a type cannot be
//      both "this CSE implements it" and "this CSE answers 5001 NOT_IMPLEMENTED for it".
//
// Neither test starts a server: both constants and features/capabilities.json are static
// artifacts of this repo, not something that requires one.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SUPPORTED_STANDARD_TYPES, UNIMPLEMENTED_TYPES } = require("../cse/resource-types");

function standardTypesWithAnySupportedOperation() {
  const raw = fs.readFileSync(
    path.join(__dirname, "..", "features", "capabilities.json"),
    "utf8"
  );
  const { entries } = JSON.parse(raw);

  return entries
    .filter((e) => e.ty < 100)
    .filter((e) => Object.values(e.operations || {}).some((op) => op.supported))
    .map((e) => e.ty);
}

test("SUPPORTED_STANDARD_TYPES equals the standard types features/capabilities.json found working", () => {
  const fromProbe = standardTypesWithAnySupportedOperation().sort((a, b) => a - b);
  const fromConstant = [...SUPPORTED_STANDARD_TYPES].sort((a, b) => a - b);

  assert.deepEqual(
    fromConstant,
    fromProbe,
    `SUPPORTED_STANDARD_TYPES (${JSON.stringify(fromConstant)}) must match the standard types ` +
    `features/capabilities.json's probe found supported (${JSON.stringify(fromProbe)}) -- ` +
    `re-run npm run probe-capabilities if this drifted after an implementation change`
  );
});

test("SUPPORTED_STANDARD_TYPES and UNIMPLEMENTED_TYPES are disjoint", () => {
  const overlap = SUPPORTED_STANDARD_TYPES.filter((ty) => UNIMPLEMENTED_TYPES.includes(ty));
  assert.deepEqual(overlap, [],
    "a type cannot be both advertised as supported in srt and answered 5001 NOT_IMPLEMENTED");
});
