"use strict";
// notificationEventType (net) values, and which of them this CSE actually acts on.
//
// CDT-enumerationTypes.xsd defines the type as an xs:integer restricted to eight enumerations, and
// TS-0001:9.6.8 table 9.6.8-3 gives each one its meaning:
//
//   1 Update_of_Resource                                    -- implemented
//   2 Delete_of_Resource                                    -- implemented
//   3 Create_of_Direct_Child_Resource                       -- implemented
//   4 Delete_of_Direct_Child_Resource                       -- implemented
//   5 Retrieve_of_Container_Resource_With_No_Child_Resource  -- not implemented
//   6 Trigger_Received_For_AE_Resource                       -- not implemented
//   7 Blocking_Update                                        -- not implemented
//   8 Report_on_missing_data_points                          -- not implemented
//
// The two rejections are deliberately different codes, because they are different mistakes.
// A value outside the enumeration (0, 9, 99) is not a oneM2M value at all: the representation is
// invalid, which is BAD_REQUEST. A value inside it that this CSE does not act on is a valid
// request for a capability that is absent, which is NOT_IMPLEMENTED -- the same distinction
// v4.17.1 drew for unimplemented resource types, where 5000 had been claiming the server broke.
//
// Both used to be accepted. cse/noti.js branches on 1, 2, 3 and 4 only, so a <subscription> asking
// for any other value was created, answered 2001, and then never fired -- no error and no
// notification, which is the hardest of the three outcomes to diagnose from the outside.
//
// This list lives in its own file so a test can read it without loading the CSE: requiring
// cse/noti.js pulls in the MQTT binding and the models, and requiring cse/hostingCSE.js pulls in
// configuration that only exists inside a running server process.

// Every value the enumeration defines.
const DEFINED_NET = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

// The subset cse/noti.js has a branch for. Adding a branch there means adding the value here, and
// test/notification-event-type.test.js fails if the two drift.
const IMPLEMENTED_NET = new Set([1, 2, 3, 4]);

// Returns the net values in enc that are outside the enumeration entirely, or [] if there are none.
// The caller turns a non-empty result into BAD_REQUEST.
//
// This is checked here rather than by a Joi .min(1).max(8) on the array items, because Joi reports
// an item failure by its position: {"net":[9]} and {"net":[99]} both produced "0 must be less than
// or equal to 8", where the 0 is the array index and not the value. The two are indistinguishable
// to the client, and at the lower bound the index happens to read like a value -- {"net":[0]} said
// "0 must be larger than or equal to 1", which looks correct by coincidence. Reported as M4-009.
function undefined_net(enc) {
    if (!enc || !Array.isArray(enc.net)) return [];
    return enc.net.filter(v => Number.isInteger(v) && !DEFINED_NET.has(v));
}

// Returns the net values in enc that are defined by oneM2M but not acted on here, or [] if there
// are none. The caller turns a non-empty result into NOT_IMPLEMENTED.
function unimplemented_net(enc) {
    if (!enc || !Array.isArray(enc.net)) return [];
    return enc.net.filter(v => DEFINED_NET.has(v) && !IMPLEMENTED_NET.has(v));
}

module.exports = { DEFINED_NET, IMPLEMENTED_NET, undefined_net, unimplemented_net };
