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
// The CSE-relative spelling of a resource ID that names something on this CSE.
//
// TS-0001:7.2 gives three forms for the same resource: CSE-Relative ("Mobius/ae1"), SP-Relative
// ("/Mobius4/Mobius/ae1") and Absolute ("//localhost/Mobius4/Mobius/ae1"). The Originator arrives
// in one of them and a notificationURI may be written in another, so comparing them as strings
// would fail to recognise a subscriber notifying itself and send it a verification request for its
// own subscription.
//
// Written here rather than delegated to reqPrim's get_to_info, which does the same job and more.
// Requiring reqPrim pulls in the CSE's module graph, and cse/datasetManager.js reads
// config.get("cse.admin") at load time -- an identity config/default.json deliberately does not
// ship. This module then could not be loaded at all without a deployment's own configuration:
// green on any machine with config/local.json, and a load-time throw in CI, which is exactly what
// happened. A predicate over strings should not need a configured CSE to answer.
//
// What this does NOT collapse, and get_to_info did not either: an unstructured ID against a
// structured one. An Originator of "C3tXgC" and a notificationURI of "Mobius/ae1" can be the same
// <AE>, and telling so needs a database lookup, not string work (BACKLOG-134).
function cse_relative(id) {
    if (typeof id !== "string" || id === "") return id;
    const sp_prefix = `${config.cse.sp_id}${config.cse.cse_id}/`;      // //sp/cse-id/
    if (id.startsWith(sp_prefix)) return id.slice(sp_prefix.length);
    const cse_prefix = `${config.cse.cse_id}/`;                        // /cse-id/
    if (id.startsWith(cse_prefix)) return id.slice(cse_prefix.length);
    return id;
}

// Do these two IDs name the same resource on this CSE?
//
// One <AE> answers to more than one name. The Originator of a subscription creation arrives as its
// AE-ID -- "C3tXgC" -- while a notificationURI naming the same AE is usually written as a path,
// "Mobius/ae1". TS-0004:7.4.8.2.1 Recv-6.4 excludes notificationURI entries that "are not the
// Originator", so failing to see those two as one entity means sending a subscriber a verification
// request for its own subscription: it is asked to confirm a subscription it is in the middle of
// creating.
//
// String work cannot close that gap, so this resolves each name to the ri it points at. mobius4
// gives an <AE> the same value for ri and aei, which is what makes an AE-ID comparable with a
// resolved path.
//
// Reached only when the two names differ as text, and only for names rooted at this <CSEBase>.
// An ID belonging to another CSE cannot be resolved here and the lookup table does not hold it, so
// asking would be a wasted round trip on every subscription creation.
async function same_resource(a_relative, b_relative) {
    const local = (v) => typeof v === "string" && v !== "" &&
        (!v.includes("/") || v.startsWith(`${config.cse.csebase_rn}/`));
    if (!local(a_relative) || !local(b_relative)) return false;

    const Lookup = require("../models/lookup-model");
    const to_ri = async (v) => {
        if (!v.includes("/")) return v;                       // already unstructured
        const row = await Lookup.findOne({ where: { sid: v }, attributes: ["ri"] });
        return row ? row.ri : null;
    };

    const [a_ri, b_ri] = await Promise.all([to_ri(a_relative), to_ri(b_relative)]);
    return a_ri !== null && b_ri !== null && a_ri === b_ri;
}

// The notificationURI entries that need a verification request: resource-ID form, and not the
// Originator (TS-0004:7.4.8.2.1 Recv-6.4).
async function verification_targets(nu_list, originator) {
    const candidates = (nu_list || []).filter(is_resource_id_target);
    if (candidates.length === 0) return [];

    const own = cse_relative(originator);
    const targets = [];
    for (const nu of candidates) {
        const relative = cse_relative(nu);
        if (relative === own) continue;         // the same name, whichever way it is spelled

        // Different names can still be one resource. Only this case pays for a query.
        //
        // A failed lookup must not turn a database problem into a refused subscription creation,
        // so it degrades to "not the same", which sends a verification the subscriber may not have
        // needed -- a wasted request rather than a wrong answer.
        let same = false;
        try {
            same = await same_resource(relative, own);
        } catch (err) {
            require("../logger").warn({ err: err.message, nu, originator },
                "could not resolve a notificationURI while selecting verification targets");
        }
        if (!same) targets.push(nu);
    }
    return targets;
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

// TS-0004:7.5.1.2.3, sender side: set verificationRequest to true and creator to the Originator
// ID of the subscription creation request, with To set to the notificationURI; the primitive is
// duplicated per entry. sur is deliberately absent -- the clause does not ask for it and the
// <subscription> does not exist yet.
//
// Recv-6.4 gives two failure paths and one status code for both: if the request cannot be sent,
// SUBSCRIPTION_VERIFICATION_INITIATION_FAILED; if it was sent and any response is not "OK",
// the same.
async function verify_targets(nu_list, originator) {
    if (!verification_enabled()) return null;

    const targets = await verification_targets(nu_list, originator);
    if (targets.length === 0) return null;

    const enums = require("../config/enums");
    const logger = require("../logger");
    const config_mod = require("config");
    const { send_verification } = require("./noti");

    for (const target of targets) {
        let rsc;
        try {
            rsc = await send_verification(target, originator,
                config_mod.cse.notification_timeout_seconds * 1000);
        } catch (err) {
            logger.info({ target, err: err.message }, "subscription verification could not be sent");
            return {
                rsc: enums.rsc_str["SUBSCRIPTION_VERIFICATION_INITIATION_FAILED"],
                dbg: `the verification request to ${target} could not be sent`,
            };
        }
        if (Number(rsc) !== enums.rsc_str["OK"]) {
            logger.info({ target, rsc }, "subscription verification refused by the target");
            return {
                rsc: enums.rsc_str["SUBSCRIPTION_VERIFICATION_INITIATION_FAILED"],
                dbg: `the verification request to ${target} was answered ${rsc}`,
            };
        }
    }
    return null;
}

module.exports = {
    is_resource_id_target,
    cse_relative,
    verification_targets,
    verification_enabled,
    handle_verification,
    verify_targets,
};
