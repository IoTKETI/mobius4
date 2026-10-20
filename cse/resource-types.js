"use strict";
// The oneM2M-standard resource types this CSE implements, published as the <CSEBase>'s
// supportedResourceType (srt) attribute. TS-0001:9.6.3: "List of the resource types which are
// supported in the CSE. This attribute contains subset of resource types listed in clause 9.2."
//
// DEC-137 (mobius4-dev-tool): this used to be a deployment config value
// (cse.supported_resource_types), written into the <CSEBase> once at create_cb time and never
// looked at again. That made srt describe what an operator typed into config/default.json
// rather than what the running code actually implements -- an upgrade that added a new resource
// type never advertised it without a hand-written SQL UPDATE (db/migrations/v4.16.0.sql for
// 29/30), and v4.5.0 added ty 28 with no migration at all, so deployments that predate it still
// answer an srt without 28 to this day. srt is implementation fact, not configuration, so it
// now lives here as a constant db/init.js writes at create and keeps in sync with on every boot
// (sync_cb_with_config).
//
// TR-0071's AI/ML types (101-107, <modelRepo>/<mlModel>/...) are deliberately absent: they are
// R5 draft, not oneM2M-standard, even though they are fully implemented and client-creatable.
// See cse/hostingCSE.js's UNIMPLEMENTED_TYPES comment for the other half of this boundary --
// "not in srt" and "not implemented" are different lists, and conflating them once caused every
// TR-0071 create to be refused with 5001 (test/unimplemented-and-clearing.test.js pins this).
//
// Adding a newly implemented standard type here is the whole upgrade step: db/init.js writes it
// into every <CSEBase> (new or existing) the next time the CSE starts.
const SUPPORTED_STANDARD_TYPES = Object.freeze([1, 2, 3, 4, 5, 9, 16, 23, 28, 29, 30]);

// oneM2M resource types this CSE does not implement. Lives alongside SUPPORTED_STANDARD_TYPES
// (not inside cse/hostingCSE.js, which requiring from a test process pulls in configuration
// that only exists inside a spawned server -- see test/unimplemented-and-clearing.test.js) so
// a test can check the two lists are disjoint without needing a running CSE. See
// cse/hostingCSE.js's unsupported_resource_type() for where this is actually enforced, and the
// comment there for the full reasoning (<semanticDescriptor> 24, <dynamicAuthorizationConsultation> 34).
const UNIMPLEMENTED_TYPES = Object.freeze([24, 34]);

module.exports = { SUPPORTED_STANDARD_TYPES, UNIMPLEMENTED_TYPES };
