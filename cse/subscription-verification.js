"use strict";
// Subscription verification -- TS-0004:7.4.8.2.1 Recv-6.4 and TS-0004:7.5.1.2.3.
//
// Recv-6.4: "If any of the notificationURI entries are not the Originator and are formatted as
// oneM2M-compliant resource-IDs, the Hosting CSE may send a Subscription Verification request
// primitive to each of them as described in clause 7.5.1.2.3."
//
// It is "may", not "shall" -- so this is off by default and turned on for conformance testing.
// See the design document for why: turning it on makes a subscription creation that used to
// succeed fail whenever the notification target does not answer, and that target belongs to
// somebody else's deployment.
const config = require("config");

// The same rule cse/noti.js uses to decide whether an nu entry needs a poa lookup, which is
// literally `startsWith('http')` and `startsWith('mqtt')` there. Kept identical on purpose: if
// the two ever disagree, a target would be notified but never verified (or the reverse), and
// neither failure announces itself.
//
// Identical includes the parts that are arguably wrong. "http" catches https, so it is not listed
// separately. coap is NOT listed even though the standard names it as a binding, because mobius4
// has no coap binding and noti.js does not exclude it -- adding it here would have made a
// coap:// target a URL to this module and a resource-ID to noti.js, which is exactly the split
// this comment claims does not exist. And an <AE> named "httpSink" is misread as a URL by both.
// Fix them together or not at all.
const URL_SCHEMES = ["http", "mqtt"];

function is_resource_id_target(nu_entry) {
    if (typeof nu_entry !== "string") return false;
    return !URL_SCHEMES.some((scheme) => nu_entry.startsWith(scheme + "://") || nu_entry.startsWith(scheme));
}

// Two entries can name the same entity in different spellings -- "/Mobius4/Mobius/ae1" and
// "Mobius/ae1" are one AE -- so the Originator is excluded by identity, not by string equality.
// get_to_info collapses a local ID to its CSE-relative form; for a resource on another CSE it is
// a passthrough, so two foreign spellings still compare unequal. That is a known limit, not an
// oversight: resolving a foreign ID would need that CSE, which this check cannot reach.
function verification_targets(nu_list, originator) {
    // Required lazily: reqPrim requires this module's callers, and a top-level require here
    // closes the cycle.
    const { get_to_info } = require("./reqPrim");
    const normalise = (v) => {
        if (typeof v !== "string" || v === "") return v;
        const { shortest_to } = get_to_info({ to: v });
        return shortest_to || v;
    };
    const own = normalise(originator);
    return (nu_list || []).filter((nu) => {
        if (!is_resource_id_target(nu)) return false;
        return nu !== originator && normalise(nu) !== own;
    });
}

function verification_enabled() {
    return config.cse.subscription_verification === true;
}

// TS-0004:7.5.1.2.3, receiver side: "The Receiver shall check if the creator of the
// <subscription> resource and the Originator have the privilege to receive NOTIFY requests to
// the notificationURI. If the creator does not, the Receiver shall respond with
// SUBSCRIPTION_CREATOR_HAS_NO_PRIVILEGE; if the Originator does not, with
// SUBSCRIPTION_HOST_HAS_NO_PRIVILEGE; otherwise a successful response."
//
// Returns true when this took over the response, false when the caller should carry on with the
// ordinary notification path. Written as a takeover rather than a branch in reqPrim so that the
// two callers (HTTP and MQTT) cannot drift apart.
async function handle_verification(req_prim, resp_prim) {
    const sgn = req_prim.pc && req_prim.pc["m2m:sgn"];
    if (!sgn || sgn.vrq !== true) return false;

    const enums = require("../config/enums");
    const logger = require("../logger");

    if (!sgn.cr) {
        resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
        resp_prim.pc = { "m2m:dbg": "a verification request must carry creator" };
        return true;
    }

    const { access_decision } = require("./hostingCSE");
    const NOTIFY = 5;

    // Two checks, two status codes -- the clause distinguishes them, and a tester reads the
    // difference to tell which side is misconfigured.
    // to_ty has to travel with ri and to. access_decision fetches the target through
    // retrieve_a_res, which dispatches on to_ty alone -- with none, no case matches, it leaves pc
    // unset, and access_decision reads that as "the resource does not exist" and returns false.
    // Every verification would then be refused 4101 no matter who asked, and only on the success
    // path, which is the one a negative test never reaches. set_ri_sid fills all three before the
    // operation switch runs, so they are present on an inbound NOTIFY.
    const target = { ri: req_prim.ri, to: req_prim.to, to_ty: req_prim.to_ty, op: NOTIFY };

    const creator_ok = await access_decision({ ...target, fr: sgn.cr }, {});
    if (creator_ok === false) {
        resp_prim.rsc = enums.rsc_str["SUBSCRIPTION_CREATOR_HAS_NO_PRIVILEGE"];
        resp_prim.pc = { "m2m:dbg": "the subscription creator has no NOTIFY privilege for this target" };
        logger.info({ cr: sgn.cr, to: req_prim.to }, "subscription verification refused: creator");
        return true;
    }

    const host_ok = await access_decision({ ...target, fr: req_prim.fr }, {});
    if (host_ok === false) {
        resp_prim.rsc = enums.rsc_str["SUBSCRIPTION_HOST_HAS_NO_PRIVILEGE"];
        resp_prim.pc = { "m2m:dbg": "the subscription host has no NOTIFY privilege for this target" };
        logger.info({ fr: req_prim.fr, to: req_prim.to }, "subscription verification refused: host");
        return true;
    }

    resp_prim.rsc = enums.rsc_str["OK"];
    logger.debug({ cr: sgn.cr, fr: req_prim.fr, to: req_prim.to }, "subscription verification accepted");
    return true;
}

module.exports = {
    is_resource_id_target,
    verification_targets,
    verification_enabled,
    handle_verification,
};
