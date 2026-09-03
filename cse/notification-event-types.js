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
//   8 Report_on_missing_data_points                          -- implemented (v4.20.0)
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

// The subset this CSE acts on. 1-4 are branches in cse/noti.js; 8 is handled on a different
// trigger entirely -- the missing-data sweep, not a resource CRUD event -- by
// cse/missing-data-subscription.js. test/notification-event-type.test.js checks both.
const IMPLEMENTED_NET = new Set([1, 2, 3, 4, 8]);

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

// notificationContentType, TS-0001:9.6.8 table 9.6.8-4 and CDT-enumerationTypes.xsd:967.
const NCT = Object.freeze({ ALL: 1, MODIFIED: 2, RESOURCE_ID: 3, TRIGGER: 4, TIMESERIES: 5 });

// Which notificationContentType each notificationEventType allows, and which it defaults to.
//
// Table 9.6.8-4 is a grid of "valid", "valid (default)" and "n/a", and n/a means the combination
// is not a thing -- "ResourceID" says nothing for a TimeSeries notification, and "Modified
// Attributes" says nothing about a resource that was deleted. Written out here rather than
// checked case by case, because the shape that matters is the whole grid: net=8 was the only
// combination anyone had looked at, and every other invalid pair was accepted and then ignored.
//
// net 5, 6 and 7 are in the table because the table has them. This CSE does not implement them and
// unimplemented_net refuses them first, so these rows are unreachable today and are here so that
// implementing one does not also mean rediscovering its content types.
const NCT_BY_NET = Object.freeze({
    1: { allowed: [NCT.ALL, NCT.MODIFIED, NCT.RESOURCE_ID], default: NCT.ALL },
    2: { allowed: [NCT.ALL, NCT.RESOURCE_ID], default: NCT.ALL },
    3: { allowed: [NCT.ALL, NCT.RESOURCE_ID], default: NCT.ALL },
    4: { allowed: [NCT.ALL, NCT.RESOURCE_ID], default: NCT.ALL },
    5: { allowed: [NCT.ALL, NCT.RESOURCE_ID], default: NCT.ALL },
    6: { allowed: [NCT.TRIGGER], default: NCT.TRIGGER },
    7: { allowed: [NCT.MODIFIED], default: NCT.MODIFIED },
    8: { allowed: [NCT.TIMESERIES], default: NCT.TIMESERIES },
});

// TS-0004:7.5.1.2.2 step 2.1: subscribedTo carries the subscribed-to resource's ID "if
// notificationContentType is set to one of Modified Attributes, Trigger Payload or TimeSeries
// notification. Otherwise, the subscribedTo attribute shall not be present." Both halves are
// requirements -- sending it always would be as wrong as never sending it.
function notification_carries_subscribed_to(nct) {
    return nct === NCT.MODIFIED || nct === NCT.TRIGGER || nct === NCT.TIMESERIES;
}

// The effective notificationContentType of a subscription: what it set, or the default for the
// event type it asked for.
function effective_nct(enc, nct) {
    if (nct !== undefined && nct !== null) return nct;
    const net = enc && Array.isArray(enc.net) ? enc.net : [1];
    const row = NCT_BY_NET[net[0]];
    return row ? row.default : NCT.ALL;
}

// The rules that tie notificationEventType, notificationContentType and the subscribed-to resource
// together. Returns a message, or null when the combination is allowed.
//
//   TS-0001:9.6.8 table 9.6.8-3, notificationEventType row: value H "shall not be combined with
//   any other notificationEventType value".
//
//   Table 9.6.8-4: the grid above. A notificationContentType has to be valid for *every*
//   notificationEventType the subscription asks for -- a notification is generated per event, and
//   one the CSE could not render is not made acceptable by another that it could.
//
//   TS-0001:9.6.8 table 9.6.8-3, missingData row: the condition "only applies to subscribed-to
//   resources of type <timeSeries>". The clause does not say to refuse a subscription on any other
//   parent, so refusing is a choice: the alternative is to accept it and never notify, which is
//   the accept-and-stay-silent shape v4.19.0 removed from net and om. Recorded as a decision
//   without a clause behind it.
function net_combination_error(enc, nct, parent_ty) {
    // Numbers, whatever arrived. These checks run on the request body rather than on the
    // Joi-validated copy, and Joi converts -- so a client that sent {"nct": "3"} has a string here
    // and a number by the time it is stored, and every comparison below is strict. The visible
    // effect was a refusal that misnamed its own reason: nct 3 with net 3 is allowed by table
    // 9.6.8-4, and the request was rejected with "notificationContentType 3 is not valid with
    // notificationEventType 3". A oneM2M JSON body should carry these as numbers, but this CSE
    // already accepts the string everywhere else, and one place disagreeing is worse than either
    // answer.
    const to_number = (v) => (v === undefined || v === null ? v : Number(v));
    const net = enc && Array.isArray(enc.net) ? enc.net.map(to_number) : null;
    if (!net) return null;
    nct = to_number(nct);
    const reports_missing_data = net.includes(8);

    if (reports_missing_data && net.length > 1) {
        return 'notificationEventType 8 cannot be combined with any other notificationEventType value';
    }

    if (nct !== undefined && nct !== null) {
        for (const value of net) {
            const row = NCT_BY_NET[value];
            if (row && !row.allowed.includes(nct)) {
                return `notificationContentType ${nct} is not valid with notificationEventType ${value}`;
            }
        }
    }

    if (reports_missing_data && parent_ty !== undefined && Number(parent_ty) !== 29) {
        return 'notificationEventType 8 requires the subscribed-to resource to be a <timeSeries>';
    }
    return null;
}

module.exports = {
    DEFINED_NET, IMPLEMENTED_NET, NCT, NCT_BY_NET,
    undefined_net, unimplemented_net, net_combination_error,
    effective_nct, notification_carries_subscribed_to,
};
